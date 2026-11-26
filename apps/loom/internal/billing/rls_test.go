package billing

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	core "github.com/envoyproxy/go-control-plane/envoy/extensions/common/ratelimit/v3"
	rlsv3 "github.com/envoyproxy/go-control-plane/envoy/service/ratelimit/v3"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/quota"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/mem"
)

func desc(reqID, keyID, model, kind string, addend uint64) *core.RateLimitDescriptor {
	return &core.RateLimitDescriptor{
		Entries: []*core.RateLimitDescriptor_Entry{
			{Key: "request_id", Value: reqID}, {Key: "key_id", Value: keyID}, {Key: "model", Value: model}, {Key: "kind", Value: kind},
		},
		HitsAddend: wrapperspb.UInt64(addend),
	}
}

func TestRLSCheckAndAmend(t *testing.T) {
	st := mem.New()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg, _ := config.LoadDefaults()
	spec, err := pricing.ParseSpec([]byte("models:\n  lab-model: {model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1}\n"))
	require.NoError(t, err)
	pr := pricing.NewService(cfg.Pricing, cfg.Quota.ReserveTokens, st, nil, log)
	dir := t.TempDir()
	writePricing(t, dir)
	cfg.Pricing.ConfigMapPath = dir + "/pricing.yaml"
	pr = pricing.NewService(cfg.Pricing, cfg.Quota.ReserveTokens, st, nil, log)
	require.NoError(t, pr.Start(context.Background(), time.Minute))
	defer pr.Stop()
	_ = spec
	q := quota.NewService(cfg.Quota, st, nil, log)
	acct, _ := st.CreateAccount(context.Background(), store.Account{ID: uuid.New(), Name: "alice", Group: "default", Status: "active"})
	key, _ := st.CreateKey(context.Background(), store.Key{ID: uuid.New(), AccountID: acct.ID, Name: "k", KeyHash: "h", KeyPreview: "p", Status: "active"}, nil)
	card, _ := pr.Lookup(context.Background(), "lab-model", "default")
	_, err = q.Reserve(context.Background(), key, card, "req-1", time.Now())
	require.NoError(t, err)

	ing := NewIngest(cfg.Billing, st, pr, nil, log, NewResolver(st, time.Minute))
	srv := NewRLSServer(ing, "loom-billing")

	// 请求阶段 check：全 0 → OK 且不结算
	r, err := srv.ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{Domain: "loom-billing",
		Descriptors: []*core.RateLimitDescriptor{desc("req-1", key.ID.String(), "lab-model", "input", 0)}})
	require.NoError(t, err)
	assert.Equal(t, rlsv3.RateLimitResponse_OK, r.OverallCode)
	n, _ := st.CountReservations(context.Background())
	assert.Equal(t, int64(1), n, "check must not settle")

	// amend：三个描述符 → 一条结算，预扣释放
	r, err = srv.ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{Domain: "loom-billing",
		Descriptors: []*core.RateLimitDescriptor{desc("req-1", key.ID.String(), "lab-model", "input", 1000),
			desc("req-1", key.ID.String(), "lab-model", "cached", 200), desc("req-1", key.ID.String(), "lab-model", "output", 500)}})
	require.NoError(t, err)
	assert.Equal(t, rlsv3.RateLimitResponse_OK, r.OverallCode)
	k, _ := st.GetKey(context.Background(), key.ID)
	assert.Equal(t, int64(1_820_000), k.QuotaUsed)
	assert.Equal(t, int64(0), k.Reserved)
	n, _ = st.CountReservations(context.Background())
	assert.Equal(t, int64(0), n)

	// 其他 domain：不处理
	r, err = srv.ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{Domain: "other",
		Descriptors: []*core.RateLimitDescriptor{desc("req-x", key.ID.String(), "lab-model", "input", 999)}})
	require.NoError(t, err)
	assert.Equal(t, rlsv3.RateLimitResponse_OK, r.OverallCode)
	assert.Empty(t, r.Statuses)
}

func TestRLSAmendErrorReturnsERROR(t *testing.T) {
	// 没有预扣记录且 model 未定价 → pricing ErrNotPriced 不算错；这里用无主请求（无 key、无账户）也 OK。
	// 真正会失败的是存储错误；用 "无 pricing 服务" 模拟：spec 未加载时 Lookup 返回错误 → settle 失败 → ERROR
	st := mem.New()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg, _ := config.LoadDefaults()
	cfg.Pricing.PGFallback = false
	pr := pricing.NewService(cfg.Pricing, cfg.Quota.ReserveTokens, st, nil, log) // 未 Start → Spec() 返回错误
	ing := NewIngest(cfg.Billing, st, pr, nil, log, NewResolver(st, time.Minute))
	srv := NewRLSServer(ing, "loom-billing")
	r, err := srv.ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{Domain: "loom-billing",
		Descriptors: []*core.RateLimitDescriptor{desc("req-9", "", "lab-model", "input", 10)}})
	require.NoError(t, err)
	assert.Equal(t, rlsCodeError, r.OverallCode)
}
