package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/quota"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/mem"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

const pricingYAML = `
defaults: {model_ratio: 1, completion_ratio: 1, cache_ratio: 1, unknown_model: deny}
groups:
  default: {ratio: 1}
  vip: {ratio: 0.5}
models:
  lab-model:     {model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1}
  lab-image:     {model_price: 0.04}
`

type fixture struct {
	st         *mem.Mem
	engine     *Engine
	pricing    *pricing.Service
	alice      store.Key // 5,000,000 nano 额度
	bob        store.Key // 账户无限、Key 无限
	carol      store.Key // 停用
	vip        store.Key // vip 分组 0.5
	plaintexts map[uuid.UUID]string
}

func newFixture(t *testing.T, mutate func(*config.Config)) *fixture {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "pricing.yaml")
	require.NoError(t, os.WriteFile(path, []byte(pricingYAML), 0o644))

	cfg, err := config.LoadDefaults()
	require.NoError(t, err)
	cfg.Pricing.ConfigMapPath = path
	cfg.Pricing.PGFallback = true
	cfg.Auth.Cache.TTL = 50 * time.Millisecond
	if mutate != nil {
		mutate(cfg)
	}
	st := mem.New()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	pr := pricing.NewService(cfg.Pricing, cfg.Quota.ReserveTokens, st, nil, log)
	require.NoError(t, pr.Start(context.Background(), time.Second))
	q := quota.NewService(cfg.Quota, st, nil, log)
	e := NewEngine(cfg.Auth, st, pr, q, nil, log)
	t.Cleanup(func() { e.Close(); pr.Stop() })

	f := &fixture{st: st, engine: e, pricing: pr, plaintexts: map[uuid.UUID]string{}}
	ctx := context.Background()
	limit := int64(5_000_000)
	acct, err := st.CreateAccount(ctx, store.Account{ID: uuid.New(), Name: "alice", Group: "default", Status: "active", QuotaLimit: &limit})
	require.NoError(t, err)
	f.alice = f.mkKey(t, acct.ID, "alice", &limit)
	bobAcct, err := st.CreateAccount(ctx, store.Account{ID: uuid.New(), Name: "bob", Group: "default", Status: "active"})
	require.NoError(t, err)
	f.bob = f.mkKey(t, bobAcct.ID, "bob", nil)
	carol, err := st.CreateAccount(ctx, store.Account{ID: uuid.New(), Name: "carol", Group: "default", Status: "disabled"})
	require.NoError(t, err)
	f.carol = f.mkKey(t, carol.ID, "carol", nil)
	vip, err := st.CreateAccount(ctx, store.Account{ID: uuid.New(), Name: "vip", Group: "vip", Status: "active"})
	require.NoError(t, err)
	f.vip = f.mkKey(t, vip.ID, "vip", nil)
	return f
}

func (f *fixture) mkKey(t *testing.T, accountID uuid.UUID, name string, limit *int64) store.Key {
	t.Helper()
	plain := "loom-k-" + name + "-" + uuid.NewString()[:8]
	k, err := f.st.CreateKey(context.Background(), store.Key{ID: uuid.New(), AccountID: accountID, Name: name, KeyHash: HashKey(plain),
		KeyPreview: plain[:12], Status: "active", QuotaLimit: limit}, nil)
	require.NoError(t, err)
	f.plaintexts[k.ID] = plain
	return k
}

func body(model string) []byte {
	b, _ := json.Marshal(map[string]any{"model": model, "messages": []any{}})
	return b
}

func (f *fixture) eval(headers map[string]string, model string) Decision {
	req := Request{Headers: headers, Body: body(model), Source: "http", Now: time.Now()}
	return f.engine.Evaluate(context.Background(), req)
}

func (f *fixture) keyHeader(k store.Key) map[string]string {
	return map[string]string{"x-api-key": f.plaintexts[k.ID]}
}

func TestDenyMatrix(t *testing.T) {
	f := newFixture(t, nil)
	cases := []struct {
		name   string
		hdr    map[string]string
		model  string
		status int
		reason string
	}{
		{"missing credential", map[string]string{}, "lab-model", 401, loom.ReasonMissingCredential},
		{"unknown key", map[string]string{"x-api-key": "loom-nope"}, "lab-model", 401, loom.ReasonUnknownAPIKey},
		{"disabled account", f.keyHeader(f.carol), "lab-model", 403, loom.ReasonClientInactive},
		{"model not priced", f.keyHeader(f.bob), "no-such-model", 403, loom.ReasonModelNotPriced},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := f.eval(c.hdr, c.model)
			assert.False(t, d.Allow)
			assert.Equal(t, c.status, d.Status)
			assert.Equal(t, c.reason, d.Reason)
			assert.Equal(t, c.reason, d.Headers["x-loom-deny-reason"])
			var eb errorBody
			require.NoError(t, json.Unmarshal(d.Body, &eb))
			assert.Equal(t, c.reason, eb.Error.Code)
		})
	}
}

func TestAllowAndReserve(t *testing.T) {
	f := newFixture(t, func(c *config.Config) { c.Auth.Cache.Enabled = false })
	d := f.eval(f.keyHeader(f.alice), "lab-model")
	require.True(t, d.Allow)
	// 预扣 1024×1000 + 1024×2000 = 3,072,000
	assert.Equal(t, int64(3_072_000), d.ReserveNanos)
	assert.Equal(t, "alice", d.Headers["x-loom-client-id"])
	assert.Equal(t, f.alice.ID.String(), d.Headers["x-loom-key-id"])
	assert.NotEmpty(t, d.Headers["x-loom-request-id"])
	assert.Equal(t, "1928000", d.Headers["x-loom-quota-remaining"])
	res, err := f.st.GetReservation(context.Background(), d.Headers["x-loom-request-id"])
	require.NoError(t, err)
	assert.Equal(t, int64(3_072_000), res.Nanos)
}

func TestInsufficientQuotaOnThirdRequest(t *testing.T) {
	f := newFixture(t, func(c *config.Config) { c.Auth.Cache.Enabled = false })
	// 前两次放行并按 1,820,000 结算，第三次剩余 1,360,000 < 预扣 3,072,000 → 403
	d1 := f.eval(f.keyHeader(f.alice), "lab-model")
	require.True(t, d1.Allow)
	settle(t, f, d1, 1000, 500, 200)
	d2 := f.eval(f.keyHeader(f.alice), "lab-model")
	require.True(t, d2.Allow)
	settle(t, f, d2, 1000, 500, 200)
	d3 := f.eval(f.keyHeader(f.alice), "lab-model")
	assert.False(t, d3.Allow)
	assert.Equal(t, 403, d3.Status)
	assert.Equal(t, loom.ReasonInsufficientQuota, d3.Reason)
	k, _ := f.st.GetKey(context.Background(), f.alice.ID)
	assert.Equal(t, int64(3_640_000), k.QuotaUsed)
}

func settle(t *testing.T, f *fixture, d Decision, in, out, cached int64) {
	t.Helper()
	card, err := f.pricing.Lookup(context.Background(), d.Model, "default")
	require.NoError(t, err)
	kid, aid := d.KeyID, d.AccountID
	_, err = f.st.SettleUsage(context.Background(), store.UsageEvent{RequestID: d.RequestID, KeyID: &kid, AccountID: &aid, Model: d.Model,
		InputTokens: in, OutputTokens: out, CachedTokens: cached, CostNanos: card.Cost(in, out, cached)})
	require.NoError(t, err)
}

func TestPerCallReserve(t *testing.T) {
	f := newFixture(t, nil)
	d := f.eval(f.keyHeader(f.bob), "lab-image")
	require.True(t, d.Allow)
	assert.Equal(t, int64(40_000_000), d.ReserveNanos)
}

func TestGroupRatioApplied(t *testing.T) {
	f := newFixture(t, nil)
	d := f.eval(f.keyHeader(f.vip), "lab-model")
	require.True(t, d.Allow)
	// vip 0.5 → input 500 / output 1000 → 预扣 1024×500 + 1024×1000
	assert.Equal(t, int64(1_536_000), d.ReserveNanos)
}

func TestModelAllowlist(t *testing.T) {
	f := newFixture(t, nil)
	_, err := f.st.UpdateKey(context.Background(), f.bob.ID, "active", []string{"lab-image"}, nil, nil, "bob")
	require.NoError(t, err)
	d := f.eval(f.keyHeader(f.bob), "lab-model")
	assert.False(t, d.Allow)
	assert.Equal(t, loom.ReasonModelNotAllowed, d.Reason)
}

func TestPGFallbackPricing(t *testing.T) {
	f := newFixture(t, nil)
	require.NoError(t, f.st.UpsertModelPricing(context.Background(), store.ModelPrice{Model: "pg-only", ModelRatio: 0.25, CompletionRatio: 1, CacheRatio: 1, Enabled: true}))
	d := f.eval(f.keyHeader(f.bob), "pg-only")
	require.True(t, d.Allow)
	card, err := f.pricing.Lookup(context.Background(), "pg-only", "default")
	require.NoError(t, err)
	assert.Equal(t, loom.PriceSourcePG, card.Source)
}

func TestCredentialExtraction(t *testing.T) {
	f := newFixture(t, nil)
	raw := "loom-" + uuid.NewString()
	_, _ = f.st.CreateKey(context.Background(), store.Key{ID: uuid.New(), AccountID: f.bob.AccountID, Name: "x", KeyHash: HashKey(raw), KeyPreview: "p", Status: "active"}, nil)
	d := f.eval(map[string]string{"authorization": "Bearer " + raw}, "lab-model")
	assert.True(t, d.Allow)
	d = f.eval(map[string]string{"authorization": raw}, "")
	assert.True(t, d.Allow, "no model → allow without reservation")
	assert.Equal(t, int64(0), d.ReserveNanos)
}

func TestHTTPFacade(t *testing.T) {
	f := newFixture(t, nil)
	raw := "loom-" + uuid.NewString()
	k, err := f.st.CreateKey(context.Background(), store.Key{ID: uuid.New(), AccountID: f.bob.AccountID, Name: "x", KeyHash: HashKey(raw), KeyPreview: "p", Status: "active"}, nil)
	require.NoError(t, err)
	f.plaintexts[k.ID] = raw
	h := f.engine.HTTPHandler(nil)
	req := httptest.NewRequest(http.MethodPost, "/check", bytes.NewReader(body("lab-model")))
	req.Header.Set("Authorization", "Bearer "+raw)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, 200, rec.Code)
	assert.Equal(t, "bob", rec.Header().Get("x-loom-client-id"))

	req = httptest.NewRequest(http.MethodPost, "/check", bytes.NewReader(body("lab-model")))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, 401, rec.Code)
	assert.Equal(t, loom.ReasonMissingCredential, rec.Header().Get("x-loom-deny-reason"))
}

func TestConcurrentReserveAllowsExactlyFive(t *testing.T) {
	f := newFixture(t, func(c *config.Config) {
		c.Quota.ReserveTokens = config.ReserveTokens{Input: 256, Output: 256} // 预扣 256×1000+256×2000 = 768,000
	})
	// 额度 5,000,000 / 768,000 → 恰好 6 次可预扣；用 3,900,000 让它恰好 5 次
	limit := int64(3_840_000)
	_, err := f.st.UpdateKey(context.Background(), f.alice.ID, "active", nil, &limit, nil, "alice")
	require.NoError(t, err)
	_, err = f.st.UpdateAccount(context.Background(), f.alice.AccountID, "active", nil, "default")
	require.NoError(t, err)
	var ok, denied atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			d := f.engine.Evaluate(context.Background(), Request{Headers: f.keyHeader(f.alice), Body: body("lab-model"), Source: "http", Now: time.Now()})
			if d.Allow {
				ok.Add(1)
			} else if d.Reason == loom.ReasonInsufficientQuota {
				denied.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	assert.Equal(t, int32(5), ok.Load())
	assert.Equal(t, int32(15), denied.Load())
}
