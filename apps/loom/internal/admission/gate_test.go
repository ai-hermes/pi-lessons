package admission

import (
	"context"
	"encoding/json"
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
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/throttle"
)

const testPricing = `
groups:
  default: {ratio: 1}
  vip: {ratio: 0.5}
  free: {ratio: 0}
  metered: {ratio: 1, limits: {rpm: 1}}
models:
  lab-model: {model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1}
  lab-image: {model_price: 0.04}
`

type fixture struct {
	st         *memstore.Store
	gate       *Gate
	ledger     *ledger.Ledger
	prices     *pricing.PriceTable
	plaintexts map[uuid.UUID]string

	alice store.APIKey // 账户与 Key 额度均为 5,000,000
	bob   store.APIKey // 不限额
	carol store.APIKey // 账户停用
	vera  store.APIKey // vip 分组 0.5
}

func newFixture(t *testing.T, reserve pricing.ReserveEstimate) *fixture {
	t.Helper()
	file := filepath.Join(t.TempDir(), "pricing.yaml")
	require.NoError(t, os.WriteFile(file, []byte(testPricing), 0o600))

	st := memstore.New()
	metrics := telemetry.NewMetrics("test", "test")
	log := slog.New(slog.DiscardHandler)

	priceOpts := pricing.Options{File: file, DatabaseFallbackEnabled: true, Reserve: reserve}
	prices, err := pricing.New(priceOpts, st, metrics, log)
	require.NoError(t, err)
	billingLedger := ledger.New(ledger.Options{}, st, prices, metrics, log)
	limiter := throttle.New(st, prices, metrics, log)
	billingLedger.SetTokenCounter(limiter)

	f := &fixture{
		st:         st,
		gate:       New(Options{}, st, prices, billingLedger, limiter, metrics, log),
		ledger:     billingLedger,
		prices:     prices,
		plaintexts: map[uuid.UUID]string{},
	}
	limit := int64(5_000_000)
	f.alice = f.addAPIKey(t, f.addAccount(t, store.Account{Name: "alice", QuotaLimit: &limit}), &limit)
	f.bob = f.addAPIKey(t, f.addAccount(t, store.Account{Name: "bob"}), nil)
	carol := store.Account{Name: "carol", Status: store.StatusDisabled}
	f.carol = f.addAPIKey(t, f.addAccount(t, carol), nil)
	f.vera = f.addAPIKey(t, f.addAccount(t, store.Account{Name: "vera", Group: "vip"}), nil)
	return f
}

// addAccount 创建账户；未指定的分组与状态取 default / active。
func (f *fixture) addAccount(t *testing.T, a store.Account) uuid.UUID {
	t.Helper()
	a.ID = uuid.New()
	if a.Group == "" {
		a.Group = "default"
	}
	if a.Status == "" {
		a.Status = store.StatusActive
	}
	created, err := f.st.CreateAccount(context.Background(), a)
	require.NoError(t, err)
	return created.ID
}

func (f *fixture) addAPIKey(t *testing.T, accountID uuid.UUID, limit *int64) store.APIKey {
	t.Helper()
	plaintext := "loom-test-" + uuid.NewString()
	key := store.APIKey{
		ID:         uuid.New(),
		AccountID:  accountID,
		Name:       "default",
		KeyHash:    store.HashAPIKey(plaintext),
		KeyPreview: plaintext[:12],
		Status:     store.StatusActive,
		QuotaLimit: limit,
	}
	created, err := f.st.CreateAPIKey(context.Background(), key)
	require.NoError(t, err)
	f.plaintexts[created.ID] = plaintext
	return created
}

func (f *fixture) admit(key store.APIKey, model string) Verdict {
	req := Request{Credential: f.plaintexts[key.ID], Body: chatBody(model)}
	return f.gate.Admit(context.Background(), req)
}

func (f *fixture) settle(t *testing.T, v Verdict, tokens pricing.TokenUsage) {
	t.Helper()
	usage := ledger.UsageReport{
		RequestID:  v.RequestID,
		APIKeyID:   v.APIKeyID,
		Model:      v.Model,
		TokenUsage: tokens,
		Channel:    "test",
	}
	_, err := f.ledger.Settle(context.Background(), usage)
	require.NoError(t, err)
}

func chatBody(model string) []byte {
	b, _ := json.Marshal(map[string]any{"model": model, "messages": []any{}})
	return b
}

var mockUsage = pricing.TokenUsage{Input: 1000, Cached: 200, Output: 500} // lab-model 下 1,820,000 nano

func TestAdmitDenials(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
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
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})

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
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})

	for i := range 2 {
		v := f.admit(f.alice, "lab-model")
		require.True(t, v.Allowed, "request %d", i+1)
		f.settle(t, v, mockUsage)
	}
	v := f.admit(f.alice, "lab-model")

	assert.False(t, v.Allowed)
	assert.Equal(t, ReasonInsufficientQuota, v.Reason)
	k, err := f.st.GetAPIKey(context.Background(), f.alice.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3_640_000), k.QuotaUsed)
	assert.Equal(t, int64(0), k.Reserved)
}

func TestAdmitPerCallModelReservesOneCall(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})

	v := f.admit(f.bob, "lab-image")

	require.True(t, v.Allowed)
	assert.Equal(t, int64(40_000_000), v.ReservedNanos)
	assert.Nil(t, v.RemainingNanos, "unbounded key and account")
}

func TestAdmitAppliesGroupRatio(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})

	v := f.admit(f.vera, "lab-model")

	require.True(t, v.Allowed)
	assert.Equal(t, int64(1_536_000), v.ReservedNanos, "vip 0.5: 1024 × 500 + 1024 × 1000")
}

func TestAdmitFreeGroupReservesAndChargesNothing(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	limit := int64(1)
	account := store.Account{Name: "intern", Group: "free", QuotaLimit: &limit}
	intern := f.addAPIKey(t, f.addAccount(t, account), &limit)

	v := f.admit(intern, "lab-model")
	require.True(t, v.Allowed, "free group passes even with almost no quota")
	assert.Zero(t, v.ReservedNanos)

	f.settle(t, v, pricing.TokenUsage{Input: 1000, Cached: 200, Output: 500})
	apiKey, err := f.st.GetAPIKey(context.Background(), intern.ID)
	require.NoError(t, err)
	assert.Zero(t, apiKey.QuotaUsed)
}

func TestAdmitFreeDatabaseFallbackModel(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	price := store.ModelPrice{Model: "pg-free", CompletionRatio: 1, CacheRatio: 1}
	require.NoError(t, f.st.UpsertModelPricing(context.Background(), price))

	v := f.admit(f.alice, "pg-free")

	require.True(t, v.Allowed)
	assert.Zero(t, v.ReservedNanos, "model_ratio 0 in model_pricing means free")
}

func TestAdmitEnforcesModelAllowlist(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	settings := f.bob.Settings()
	settings.ModelAllowlist = []string{"lab-image"}
	_, err := f.st.UpdateAPIKey(context.Background(), f.bob.ID, settings)
	require.NoError(t, err)

	v := f.admit(f.bob, "lab-model")

	assert.Equal(t, ReasonModelNotAllowed, v.Reason)
}

func TestAdmitUsesStoreFallbackPricing(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	price := store.ModelPrice{
		Model:           "pg-only",
		ModelRatio:      0.25,
		CompletionRatio: 1,
		CacheRatio:      1,
	}
	require.NoError(t, f.st.UpsertModelPricing(context.Background(), price))

	v := f.admit(f.bob, "pg-only")

	require.True(t, v.Allowed)
	unitPrice, err := f.prices.Lookup(context.Background(), "pg-only", "default")
	require.NoError(t, err)
	assert.Equal(t, pricing.SourceDatabase, unitPrice.PriceSource)
}

func TestAdmitWithoutModelOnlyAuthenticates(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})

	v := f.gate.Admit(context.Background(), Request{Credential: f.plaintexts[f.bob.ID], Body: []byte("plain text")})

	assert.True(t, v.Allowed)
	assert.Empty(t, v.Model)
	assert.Zero(t, v.ReservedNanos)
}

func TestAdmitPrefersModelHint(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})

	req := Request{
		Credential: f.plaintexts[f.bob.ID],
		ModelHint:  "lab-image",
		Body:       chatBody("lab-model"),
	}
	v := f.gate.Admit(context.Background(), req)

	assert.Equal(t, "lab-image", v.Model)
}

func TestAdmitConcurrentReservationsNeverOverdraw(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 256, Output: 256}) // 预扣 768,000
	limit := int64(3_840_000)                                            // 恰好 5 次
	require.NoError(t, f.st.SetAPIKeyQuota(context.Background(), f.alice.ID, store.QuotaChange{LimitNanos: &limit}))
	require.NoError(t, f.st.SetAccountQuota(context.Background(), f.alice.AccountID, store.QuotaChange{}))

	var allowed, denied atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 20 {
		wg.Go(func() {
			<-start
			switch v := f.admit(f.alice, "lab-model"); {
			case v.Allowed:
				allowed.Add(1)
			case v.Reason == ReasonInsufficientQuota:
				denied.Add(1)
			}
		})
	}
	close(start)
	wg.Wait()

	assert.Equal(t, int32(5), allowed.Load())
	assert.Equal(t, int32(15), denied.Load())
}

// enableAPIKeyCache 换成开启 API Key 缓存的准入门（默认 fixture 不缓存）。
func (f *fixture) enableAPIKeyCache() {
	cache := APIKeyCacheOptions{Enabled: true, Size: 10, TTL: time.Hour}
	f.gate = New(
		Options{APIKeyCache: cache},
		f.gate.store,
		f.gate.pricer,
		f.gate.quotaReserver,
		f.gate.limiter,
		f.gate.metrics,
		f.gate.log,
	)
}

func TestInvalidateKeyDropsCachedKey(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{})
	f.enableAPIKeyCache()
	require.True(t, f.admit(f.bob, "").Allowed)

	settings := f.bob.Settings()
	settings.Status = store.StatusDisabled
	_, err := f.st.UpdateAPIKey(context.Background(), f.bob.ID, settings)
	require.NoError(t, err)
	assert.True(t, f.admit(f.bob, "").Allowed, "stale cache until invalidated")

	f.gate.InvalidateAPIKey(f.bob.ID)
	assert.Equal(t, ReasonInactive, f.admit(f.bob, "").Reason)
}

func TestInvalidateAccountDropsCachedAccountSnapshot(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{})
	f.enableAPIKeyCache()
	require.True(t, f.admit(f.bob, "").Allowed)

	account, err := f.st.GetAccount(context.Background(), f.bob.AccountID)
	require.NoError(t, err)
	settings := account.Settings()
	settings.Status = store.StatusDisabled
	_, err = f.st.UpdateAccount(context.Background(), account.ID, settings)
	require.NoError(t, err)
	assert.True(t, f.admit(f.bob, "").Allowed, "stale account snapshot until invalidated")

	f.gate.InvalidateAccount(account.ID)
	assert.Equal(t, ReasonInactive, f.admit(f.bob, "").Reason)
}

func TestAdmitDeniesUndefinedGroup(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	// 绕过管理 API 的写入校验，模拟 pricing.yaml 热加载后删掉了账户所在分组
	ghost := f.addAPIKey(t, f.addAccount(t, store.Account{Name: "ghost", Group: "removed"}), nil)

	v := f.admit(ghost, "lab-model")

	assert.Equal(t, ReasonGroupNotPriced, v.Reason)
	assert.Zero(t, v.ReservedNanos)
	assert.True(t, f.admit(ghost, "").Allowed, "non-model requests only authenticate")
}

// blockingStore 的 API Key 查询一直阻塞到 context 结束，模拟 PG 变慢或行锁。
type blockingStore struct{ Store }

func (blockingStore) GetAPIKeyByHash(ctx context.Context, _ string) (store.APIKey, error) {
	<-ctx.Done()
	return store.APIKey{}, ctx.Err()
}

func TestAdmitGivesUpAtItsDeadline(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	f.gate = New(
		Options{Timeout: 50 * time.Millisecond},
		blockingStore{f.gate.store},
		f.gate.pricer,
		f.gate.quotaReserver,
		f.gate.limiter,
		f.gate.metrics,
		f.gate.log,
	)

	start := time.Now()
	v := f.admit(f.bob, "lab-model")

	assert.Equal(t, ReasonInternalError, v.Reason)
	assert.Less(t, time.Since(start), time.Second, "admission returns at its own deadline, before the gateway's 2s")
}

// withLimits 设置 Key 的限流配置，返回更新后的 Key。
func (f *fixture) withLimits(t *testing.T, key store.APIKey, limits store.RateLimits) store.APIKey {
	t.Helper()
	settings := key.Settings()
	settings.Limits = limits
	updated, err := f.st.UpdateAPIKey(context.Background(), key.ID, settings)
	require.NoError(t, err)
	return updated
}

func requireRateLimited(t *testing.T, v Verdict, scope store.RateScope, kind store.RateLimitKind) {
	t.Helper()
	require.Equal(t, ReasonRateLimited, v.Reason)
	require.NotNil(t, v.RateLimit)
	assert.Equal(t, store.RateLimitError{Scope: scope, Kind: kind}, *v.RateLimit)
	assert.Positive(t, v.RetryAfter)
	assert.LessOrEqual(t, v.RetryAfter, time.Minute)
}

func TestAdmitEnforcesAPIKeyRPM(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	bob := f.withLimits(t, f.bob, store.RateLimits{RPM: new(int64(2))})

	assert.True(t, f.admit(bob, "lab-model").Allowed)
	assert.True(t, f.admit(bob, "").Allowed, "non-model requests count towards RPM too")
	requireRateLimited(t, f.admit(bob, "lab-model"), store.RateScopeAPIKey, store.RateLimitRPM)
}

func TestAdmitAppliesGroupDefaultsToTheAccount(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	metered := f.addAPIKey(t, f.addAccount(t, store.Account{Name: "mia", Group: "metered"}), nil)

	assert.True(t, f.admit(metered, "lab-model").Allowed)
	requireRateLimited(t, f.admit(metered, "lab-model"), store.RateScopeAccount, store.RateLimitRPM)
}

func TestAdmitEnforcesConcurrencyUntilSettlement(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	bob := f.withLimits(t, f.bob, store.RateLimits{MaxConcurrency: new(int64(1))})

	first := f.admit(bob, "lab-model")
	require.True(t, first.Allowed)
	requireRateLimited(t, f.admit(bob, "lab-model"), store.RateScopeAPIKey, store.RateLimitConcurrency)

	f.settle(t, first, pricing.TokenUsage{Input: 10, Output: 10})
	assert.True(t, f.admit(bob, "lab-model").Allowed, "settlement frees the slot")
}

func TestAdmitReleasesRateCountWhenReserveFails(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	alice := f.withLimits(t, f.alice, store.RateLimits{RPM: new(int64(1))})
	require.NoError(t, f.st.SetAPIKeyQuota(context.Background(), alice.ID, store.QuotaChange{
		LimitNanos: new(int64(1)),
		Actor:      "test",
	}))

	assert.Equal(t, ReasonInsufficientQuota, f.admit(alice, "lab-model").Reason)
	require.NoError(t, f.st.SetAPIKeyQuota(context.Background(), alice.ID, store.QuotaChange{Actor: "test"}))
	assert.EventuallyWithT(t, func(c *assert.CollectT) {
		assert.True(c, f.admit(alice, "lab-model").Allowed, "the denied request gave its RPM slot back")
	}, 2*time.Second, 20*time.Millisecond)
}

func TestAdmitCorrectsTPMWithActualTokens(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024}) // 每次准入按 2,048 token 计入
	bob := f.withLimits(t, f.bob, store.RateLimits{TPM: new(int64(4000))})
	actual := pricing.TokenUsage{Input: 1000, Output: 500}

	first := f.admit(bob, "lab-model")
	require.True(t, first.Allowed)
	f.settle(t, first, actual) // 计数 2,048 → 1,500
	second := f.admit(bob, "lab-model")
	require.True(t, second.Allowed, "1,500 + 2,048 fits; without the correction 4,096 would not")
	f.settle(t, second, actual) // 3,000
	requireRateLimited(t, f.admit(bob, "lab-model"), store.RateScopeAPIKey, store.RateLimitTPM)
}

func TestTPMEnabledMidWindowStartsFromZero(t *testing.T) {
	f := newFixture(t, pricing.ReserveEstimate{Input: 1024, Output: 1024})
	bob := f.withLimits(t, f.bob, store.RateLimits{RPM: new(int64(100))})
	for range 3 {
		require.True(t, f.admit(bob, "lab-model").Allowed)
	}

	bob = f.withLimits(t, bob, store.RateLimits{TPM: new(int64(4000))})
	assert.True(t, f.admit(bob, "lab-model").Allowed, "tokens are only counted on levels that have a TPM limit")
}
