package admission

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/ledger"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/memstore"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

const testPricing = `
groups:
  default: {ratio: 1}
  vip: {ratio: 0.5}
models:
  lab-model: {model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1}
  lab-image: {model_price: 0.04}
`

type fixture struct {
	st         *memstore.Mem
	gate       *Gate
	ledger     *ledger.Ledger
	prices     *pricing.Table
	plaintexts map[uuid.UUID]string

	alice store.Key // 账户与 Key 额度均为 5,000,000
	bob   store.Key // 不限额
	carol store.Key // 账户停用
	vera  store.Key // vip 分组 0.5
}

func newFixture(t *testing.T, reserve pricing.ReserveTokens) *fixture {
	t.Helper()
	file := filepath.Join(t.TempDir(), "pricing.yaml")
	require.NoError(t, os.WriteFile(file, []byte(testPricing), 0o644))

	st := memstore.New()
	metrics := telemetry.NewMetrics("test", "test")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	prices, err := pricing.New(pricing.Options{File: file, StoreFallback: true, Reserve: reserve}, st, metrics, log)
	require.NoError(t, err)
	l := ledger.New(ledger.Options{}, st, prices, metrics, log)
	gate := New(Options{}, Deps{Store: st, Pricer: prices, Reserver: l, Metrics: metrics, Log: log})

	f := &fixture{st: st, gate: gate, ledger: l, prices: prices, plaintexts: map[uuid.UUID]string{}}
	limit := int64(5_000_000)
	f.alice = f.addKey(t, f.addAccount(t, "alice", "default", store.StatusActive, &limit), &limit)
	f.bob = f.addKey(t, f.addAccount(t, "bob", "default", store.StatusActive, nil), nil)
	f.carol = f.addKey(t, f.addAccount(t, "carol", "default", store.StatusDisabled, nil), nil)
	f.vera = f.addKey(t, f.addAccount(t, "vera", "vip", store.StatusActive, nil), nil)
	return f
}

func (f *fixture) addAccount(t *testing.T, name, group string, status store.Status, limit *int64) uuid.UUID {
	t.Helper()
	a, err := f.st.CreateAccount(
		context.Background(),
		store.Account{ID: uuid.New(), Name: name, Group: group, Status: status, QuotaLimit: limit},
	)
	require.NoError(t, err)
	return a.ID
}

func (f *fixture) addKey(t *testing.T, accountID uuid.UUID, limit *int64) store.Key {
	t.Helper()
	plaintext := "loom-test-" + uuid.NewString()
	k, err := f.st.CreateKey(context.Background(), store.Key{
		ID:         uuid.New(),
		AccountID:  accountID,
		Name:       "default",
		KeyHash:    store.HashAPIKey(plaintext),
		KeyPreview: plaintext[:12],
		Status:     store.StatusActive,
		QuotaLimit: limit,
	}, nil)
	require.NoError(t, err)
	f.plaintexts[k.ID] = plaintext
	return k
}

func (f *fixture) admit(key store.Key, model string) Verdict {
	return f.gate.Admit(context.Background(), Request{Credential: f.plaintexts[key.ID], Body: chatBody(model)})
}

func (f *fixture) settle(t *testing.T, v Verdict, tokens pricing.Tokens) {
	t.Helper()
	_, err := f.ledger.Settle(
		context.Background(),
		ledger.Usage{RequestID: v.RequestID, KeyID: v.KeyID, Model: v.Model, Tokens: tokens, Channel: "test"},
	)
	require.NoError(t, err)
}

func chatBody(model string) []byte {
	b, _ := json.Marshal(map[string]any{"model": model, "messages": []any{}})
	return b
}

var mockUsage = pricing.Tokens{Input: 1000, Cached: 200, Output: 500} // lab-model 下 1,820,000 nano

func TestAdmitDenials(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})
	tests := []struct {
		name       string
		credential string
		model      string
		expected   Reason
	}{
		{name: "missing credential", model: "lab-model", expected: ReasonMissingCredential},
		{name: "unknown key", credential: "loom-nope", model: "lab-model", expected: ReasonUnknownKey},
		{name: "inactive account", credential: f.plaintexts[f.carol.ID], model: "lab-model", expected: ReasonInactive},
		{
			name:       "model not priced",
			credential: f.plaintexts[f.bob.ID],
			model:      "no-such-model",
			expected:   ReasonModelNotPriced,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := f.gate.Admit(context.Background(), Request{Credential: tt.credential, Body: chatBody(tt.model)})
			assert.False(t, v.Allowed)
			assert.Equal(t, tt.expected, v.Reason)
			assert.NotEmpty(t, v.RequestID)
		})
	}
}

func TestAdmitReservesQuota(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})

	v := f.admit(f.alice, "lab-model")

	require.True(t, v.Allowed)
	assert.Equal(t, "alice", v.AccountName)
	assert.Equal(t, int64(3_072_000), v.ReservedNanos, "1024 × 1000 + 1024 × 2000")
	require.NotNil(t, v.RemainingNanos)
	assert.Equal(t, int64(1_928_000), *v.RemainingNanos)
	res, err := f.st.GetReservation(context.Background(), v.RequestID)
	require.NoError(t, err)
	assert.Equal(t, int64(3_072_000), res.Nanos)
}

func TestAdmitDeniesThirdRequestWhenQuotaRunsOut(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})

	for i := range 2 {
		v := f.admit(f.alice, "lab-model")
		require.True(t, v.Allowed, "request %d", i+1)
		f.settle(t, v, mockUsage)
	}
	v := f.admit(f.alice, "lab-model")

	assert.False(t, v.Allowed)
	assert.Equal(t, ReasonInsufficientQuota, v.Reason)
	k, err := f.st.GetKey(context.Background(), f.alice.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3_640_000), k.QuotaUsed)
	assert.Equal(t, int64(0), k.Reserved)
}

func TestAdmitPerCallModelReservesOneCall(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})

	v := f.admit(f.bob, "lab-image")

	require.True(t, v.Allowed)
	assert.Equal(t, int64(40_000_000), v.ReservedNanos)
	assert.Nil(t, v.RemainingNanos, "unbounded key and account")
}

func TestAdmitAppliesGroupRatio(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})

	v := f.admit(f.vera, "lab-model")

	require.True(t, v.Allowed)
	assert.Equal(t, int64(1_536_000), v.ReservedNanos, "vip 0.5: 1024 × 500 + 1024 × 1000")
}

func TestAdmitEnforcesModelAllowlist(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})
	_, err := f.st.UpdateKey(
		context.Background(),
		f.bob.ID,
		store.StatusActive,
		[]string{"lab-image"},
		nil,
		nil,
		"default",
	)
	require.NoError(t, err)

	v := f.admit(f.bob, "lab-model")

	assert.Equal(t, ReasonModelNotAllowed, v.Reason)
}

func TestAdmitUsesStoreFallbackPricing(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})
	require.NoError(
		t,
		f.st.UpsertModelPricing(
			context.Background(),
			store.ModelPrice{Model: "pg-only", ModelRatio: 0.25, CompletionRatio: 1, CacheRatio: 1},
		),
	)

	v := f.admit(f.bob, "pg-only")

	require.True(t, v.Allowed)
	card, err := f.prices.Lookup(context.Background(), "pg-only", "default")
	require.NoError(t, err)
	assert.Equal(t, pricing.SourceStore, card.Source)
}

func TestAdmitWithoutModelOnlyAuthenticates(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})

	v := f.gate.Admit(context.Background(), Request{Credential: f.plaintexts[f.bob.ID], Body: []byte("plain text")})

	assert.True(t, v.Allowed)
	assert.Empty(t, v.Model)
	assert.Zero(t, v.ReservedNanos)
}

func TestAdmitPrefersModelHint(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 1024, Output: 1024})

	v := f.gate.Admit(
		context.Background(),
		Request{Credential: f.plaintexts[f.bob.ID], ModelHint: "lab-image", Body: chatBody("lab-model")},
	)

	assert.Equal(t, "lab-image", v.Model)
}

func TestAdmitConcurrentReservationsNeverOverdraw(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{Input: 256, Output: 256}) // 预扣 768,000
	limit := int64(3_840_000)                                          // 恰好 5 次
	require.NoError(t, f.st.SetKeyQuota(context.Background(), f.alice.ID, &limit, 0))
	require.NoError(t, f.st.SetAccountQuota(context.Background(), f.alice.AccountID, nil, 0))

	var allowed, denied atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			switch v := f.admit(f.alice, "lab-model"); {
			case v.Allowed:
				allowed.Add(1)
			case v.Reason == ReasonInsufficientQuota:
				denied.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	assert.Equal(t, int32(5), allowed.Load())
	assert.Equal(t, int32(15), denied.Load())
}

func TestInvalidateKeyDropsCachedKey(t *testing.T) {
	f := newFixture(t, pricing.ReserveTokens{})
	f.gate = New(Options{KeyCache: KeyCacheOptions{Enabled: true, Size: 10, TTL: time.Hour}}, f.gate.deps)
	require.True(t, f.admit(f.bob, "").Allowed)

	_, err := f.st.UpdateKey(context.Background(), f.bob.ID, store.StatusDisabled, nil, nil, nil, "default")
	require.NoError(t, err)
	assert.True(t, f.admit(f.bob, "").Allowed, "stale cache until invalidated")

	f.gate.InvalidateKey(f.bob.ID)
	assert.Equal(t, ReasonInactive, f.admit(f.bob, "").Reason)
}
