package ledger

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/memstore"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

var mockTokenUsage = pricing.TokenUsage{Input: 1000, Cached: 200, Output: 500}

type fixture struct {
	st      *memstore.Store
	ledger  *Ledger
	prices  *pricing.PriceTable
	metrics *telemetry.Metrics
	apiKey  store.APIKey
}

const testPricing = `
groups:
  default: {ratio: 1}
  vip:     {ratio: 0.9}
models:
  lab-model: {model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1}
`

func newFixture(t *testing.T) *fixture {
	t.Helper()
	return newFixtureWith(t, Options{})
}

func newFixtureWith(t *testing.T, opts Options) *fixture {
	t.Helper()
	file := filepath.Join(t.TempDir(), "pricing.yaml")
	require.NoError(t, os.WriteFile(file, []byte(testPricing), 0o600))

	st := memstore.New()
	metrics := telemetry.NewMetrics("test", "test")
	log := slog.New(slog.DiscardHandler)
	priceOpts := pricing.Options{File: file, Reserve: pricing.ReserveEstimate{Input: 1024, Output: 1024}}
	prices, err := pricing.New(priceOpts, st, metrics, log)
	require.NoError(t, err)

	ctx := context.Background()
	limit := int64(5_000_000)
	acct, err := st.CreateAccount(ctx, store.Account{
		ID:         uuid.New(),
		Name:       "alice",
		Group:      "default",
		Status:     store.StatusActive,
		QuotaLimit: &limit,
	})
	require.NoError(t, err)
	apiKey, err := st.CreateAPIKey(ctx, store.APIKey{
		ID:         uuid.New(),
		AccountID:  acct.ID,
		Name:       "k",
		KeyHash:    "h",
		Status:     store.StatusActive,
		QuotaLimit: &limit,
	})
	require.NoError(t, err)

	return &fixture{
		st:      st,
		ledger:  New(opts, st, prices, metrics, log),
		prices:  prices,
		metrics: metrics,
		apiKey:  apiKey,
	}
}

func (f *fixture) reserve(t *testing.T, requestID string) ReservationHold {
	t.Helper()
	unitPrice, err := f.prices.Lookup(context.Background(), "lab-model", "default")
	require.NoError(t, err)
	reservationHold, err := f.ledger.ReserveQuota(context.Background(), ReserveRequest{APIKey: f.apiKey, UnitPrice: unitPrice, RequestID: requestID})
	require.NoError(t, err)
	return reservationHold
}

func (f *fixture) usageReport(requestID string) UsageReport {
	return UsageReport{
		RequestID:  requestID,
		APIKeyID:   f.apiKey.ID,
		Model:      "lab-model",
		TokenUsage: mockTokenUsage,
		Channel:    "test",
	}
}

func TestSettleReplacesReservationWithActualCost(t *testing.T) {
	f := newFixture(t)
	reservationHold := f.reserve(t, "req-1")
	assert.Equal(t, int64(3_072_000), reservationHold.Nanos)

	inserted, err := f.ledger.Settle(context.Background(), f.usageReport("req-1"))

	require.NoError(t, err)
	assert.True(t, inserted)
	apiKey, err := f.st.GetAPIKey(context.Background(), f.apiKey.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1_820_000), apiKey.QuotaUsed)
	assert.Zero(t, apiKey.Reserved)
	account, accountErr := f.st.GetAccount(context.Background(), f.apiKey.AccountID)
	require.NoError(t, accountErr)
	assert.Equal(t, int64(1_820_000), account.QuotaUsed)
	assert.Zero(t, account.Reserved)
	_, err = f.st.GetReservation(context.Background(), "req-1")
	assert.ErrorIs(t, err, store.ErrNotFound)
}

func TestSettleIsIdempotentPerRequest(t *testing.T) {
	f := newFixture(t)
	f.reserve(t, "req-1")
	_, err := f.ledger.Settle(context.Background(), f.usageReport("req-1"))
	require.NoError(t, err)

	inserted, err := f.ledger.Settle(context.Background(), f.usageReport("req-1"))

	require.NoError(t, err)
	assert.False(t, inserted)
	apiKey, err := f.st.GetAPIKey(context.Background(), f.apiKey.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1_820_000), apiKey.QuotaUsed)
}

func TestSettleWithoutReservationChargesDirectly(t *testing.T) {
	f := newFixture(t)

	inserted, err := f.ledger.Settle(context.Background(), f.usageReport("req-2"))

	require.NoError(t, err)
	assert.True(t, inserted)
	apiKey, err := f.st.GetAPIKey(context.Background(), f.apiKey.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1_820_000), apiKey.QuotaUsed)
}

func TestLateDuplicateBackfillsGatewayCost(t *testing.T) {
	f := newFixture(t)
	_, err := f.ledger.Settle(context.Background(), f.usageReport("req-3"))
	require.NoError(t, err)

	gatewayCost := int64(1_820_000)
	late := f.usageReport("req-3")
	late.AgentGatewayCostNanos = &gatewayCost
	_, err = f.ledger.Settle(context.Background(), late)
	require.NoError(t, err)

	events, err := f.st.ListUsage(context.Background(), nil, nil, 10)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.NotNil(t, events[0].AgentGatewayCostNanos)
	assert.Equal(t, gatewayCost, *events[0].AgentGatewayCostNanos)
}

func TestReserveFailsWhenQuotaInsufficient(t *testing.T) {
	f := newFixture(t)
	f.reserve(t, "req-1")

	unitPrice, err := f.prices.Lookup(context.Background(), "lab-model", "default")
	require.NoError(t, err)
	_, err = f.ledger.ReserveQuota(context.Background(), ReserveRequest{APIKey: f.apiKey, UnitPrice: unitPrice, RequestID: "req-2"})

	assert.True(t, IsInsufficientQuota(err))
	apiKey, err := f.st.GetAPIKey(context.Background(), f.apiKey.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3_072_000), apiKey.Reserved, "failed reservation leaves nothing frozen")
}

// commitLostStore 预扣真的提交了，但调用方收到错误：模拟提交确认在途中连接断开或 context 到期。
type commitLostStore struct{ Store }

func (s commitLostStore) ReserveQuota(
	ctx context.Context,
	r store.Reservation,
	concurrency store.ConcurrencyLimits,
) (store.QuotaReservation, error) {
	if _, err := s.Store.ReserveQuota(ctx, r, concurrency); err != nil {
		return store.QuotaReservation{}, err
	}
	return store.QuotaReservation{}, fmt.Errorf("%w: %w", store.ErrCommitOutcomeUnknown, context.DeadlineExceeded)
}

func TestReserveCompensatesWhenCommitOutcomeIsUnknown(t *testing.T) {
	f := newFixture(t)
	f.ledger.store = commitLostStore{f.st}
	unitPrice, err := f.prices.Lookup(context.Background(), "lab-model", "default")
	require.NoError(t, err)

	_, err = f.ledger.ReserveQuota(context.Background(), ReserveRequest{APIKey: f.apiKey, UnitPrice: unitPrice, RequestID: "req-lost"})

	require.ErrorIs(t, err, store.ErrCommitOutcomeUnknown)
	assert.EventuallyWithT(t, func(c *assert.CollectT) {
		apiKey, err := f.st.GetAPIKey(context.Background(), f.apiKey.ID)
		require.NoError(c, err)
		assert.Zero(c, apiKey.Reserved, "the denied request's reservation is released, not left to the reaper")
		_, err = f.st.GetReservation(context.Background(), "req-lost")
		assert.ErrorIs(c, err, store.ErrNotFound)
	}, 2*time.Second, 10*time.Millisecond)
	released := testutil.ToFloat64(f.metrics.ReserveCompensations.WithLabelValues("released"))
	assert.InDelta(t, 1, released, 0)
}
