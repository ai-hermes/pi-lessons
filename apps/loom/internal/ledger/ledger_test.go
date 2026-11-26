package ledger

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/memstore"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

var mockUsage = pricing.Tokens{Input: 1000, Cached: 200, Output: 500}

type fixture struct {
	st     *memstore.Mem
	ledger *Ledger
	prices *pricing.Table
	key    store.Key
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	file := filepath.Join(t.TempDir(), "pricing.yaml")
	require.NoError(
		t,
		os.WriteFile(
			file,
			[]byte("models:\n  lab-model: {model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1}\n"),
			0o644,
		),
	)

	st := memstore.New()
	metrics := telemetry.NewMetrics("test", "test")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	prices, err := pricing.New(
		pricing.Options{File: file, Reserve: pricing.ReserveTokens{Input: 1024, Output: 1024}},
		st,
		metrics,
		log,
	)
	require.NoError(t, err)

	limit := int64(5_000_000)
	ctx := context.Background()
	acct, err := st.CreateAccount(
		ctx,
		store.Account{ID: uuid.New(), Name: "alice", Group: "default", Status: store.StatusActive, QuotaLimit: &limit},
	)
	require.NoError(t, err)
	key, err := st.CreateKey(
		ctx,
		store.Key{
			ID:         uuid.New(),
			AccountID:  acct.ID,
			Name:       "k",
			KeyHash:    "h",
			Status:     store.StatusActive,
			QuotaLimit: &limit,
		},
		nil,
	)
	require.NoError(t, err)

	return &fixture{st: st, ledger: New(Options{}, st, prices, metrics, log), prices: prices, key: key}
}

func (f *fixture) reserve(t *testing.T, requestID string) Hold {
	t.Helper()
	card, err := f.prices.Lookup(context.Background(), "lab-model", "default")
	require.NoError(t, err)
	hold, err := f.ledger.Reserve(context.Background(), f.key, card, requestID)
	require.NoError(t, err)
	return hold
}

func (f *fixture) usage(requestID string) Usage {
	return Usage{RequestID: requestID, KeyID: f.key.ID, Model: "lab-model", Tokens: mockUsage, Channel: "test"}
}

func TestSettleReplacesReservationWithActualCost(t *testing.T) {
	f := newFixture(t)
	hold := f.reserve(t, "req-1")
	assert.Equal(t, int64(3_072_000), hold.Nanos)

	inserted, err := f.ledger.Settle(context.Background(), f.usage("req-1"))

	require.NoError(t, err)
	assert.True(t, inserted)
	k, _ := f.st.GetKey(context.Background(), f.key.ID)
	assert.Equal(t, int64(1_820_000), k.QuotaUsed)
	assert.Zero(t, k.Reserved)
	a, _ := f.st.GetAccount(context.Background(), f.key.AccountID)
	assert.Equal(t, int64(1_820_000), a.QuotaUsed)
	assert.Zero(t, a.Reserved)
	_, err = f.st.GetReservation(context.Background(), "req-1")
	assert.ErrorIs(t, err, store.ErrNotFound)
}

func TestSettleIsIdempotentPerRequest(t *testing.T) {
	f := newFixture(t)
	f.reserve(t, "req-1")
	_, err := f.ledger.Settle(context.Background(), f.usage("req-1"))
	require.NoError(t, err)

	inserted, err := f.ledger.Settle(context.Background(), f.usage("req-1"))

	require.NoError(t, err)
	assert.False(t, inserted)
	k, _ := f.st.GetKey(context.Background(), f.key.ID)
	assert.Equal(t, int64(1_820_000), k.QuotaUsed)
}

func TestSettleWithoutReservationChargesDirectly(t *testing.T) {
	f := newFixture(t)

	inserted, err := f.ledger.Settle(context.Background(), f.usage("req-2"))

	require.NoError(t, err)
	assert.True(t, inserted)
	k, _ := f.st.GetKey(context.Background(), f.key.ID)
	assert.Equal(t, int64(1_820_000), k.QuotaUsed)
}

func TestLateDuplicateBackfillsGatewayCost(t *testing.T) {
	f := newFixture(t)
	_, err := f.ledger.Settle(context.Background(), f.usage("req-3"))
	require.NoError(t, err)

	gatewayCost := int64(1_820_000)
	late := f.usage("req-3")
	late.GatewayCostNanos = &gatewayCost
	_, err = f.ledger.Settle(context.Background(), late)
	require.NoError(t, err)

	events, err := f.st.ListUsage(context.Background(), nil, nil, 10)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.NotNil(t, events[0].GatewayCostNanos)
	assert.Equal(t, gatewayCost, *events[0].GatewayCostNanos)
}

func TestReserveFailsWhenQuotaInsufficient(t *testing.T) {
	f := newFixture(t)
	f.reserve(t, "req-1")

	card, err := f.prices.Lookup(context.Background(), "lab-model", "default")
	require.NoError(t, err)
	_, err = f.ledger.Reserve(context.Background(), f.key, card, "req-2")

	assert.True(t, IsInsufficientQuota(err))
	k, _ := f.st.GetKey(context.Background(), f.key.ID)
	assert.Equal(t, int64(3_072_000), k.Reserved, "failed reservation leaves nothing frozen")
}
