package billing

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/quota"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/mem"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

func attr(k string, v *commonpb.AnyValue) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: k, Value: v}
}

func sv(s string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: s}}
}
func iv(n int64) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: n}}
}
func dv(f float64) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: f}}
}

func TestRecordFromLogRecord(t *testing.T) {
	cfg, err := config.LoadDefaults()
	require.NoError(t, err)
	am := cfg.Billing.Attributes
	lr := &logspb.LogRecord{
		TimeUnixNano: 1_700_000_000_000_000_000,
		TraceId:      make([]byte, 16), SpanId: []byte{1, 2, 3, 4, 5, 6, 7, 8},
		Attributes: []*commonpb.KeyValue{
			attr(am.InputTokens, iv(1000)), attr(am.OutputTokens, iv(500)), attr(am.CachedTokens, iv(200)),
			attr(am.GatewayCost, dv(0.00182)), attr(am.Model, sv("lab-model")), attr(am.Provider, sv("openai")),
			attr(am.RequestID, sv("req-1")), attr(am.ClientID, sv("alice")), attr(am.KeyID, sv("11111111-2222-3333-4444-555555555555")),
			attr("route", sv("llm")), attr("protocol", sv("llm")),
		},
	}
	r := RecordFromLogRecord(lr, nil, am)
	assert.Equal(t, int64(1000), r.InputTokens)
	assert.Equal(t, int64(200), r.CachedTokens)
	assert.Equal(t, "lab-model", r.Model)
	assert.Equal(t, "req-1", r.RequestID)
	assert.Equal(t, "11111111-2222-3333-4444-555555555555", r.KeyID.String())
	require.NotNil(t, r.GatewayCostNanos)
	assert.Equal(t, int64(1_820_000), *r.GatewayCostNanos)
	assert.Len(t, r.TraceID, 32)
	assert.Equal(t, "0102030405060708", r.SpanID)
}

func TestSettleChargesReservationThenReleases(t *testing.T) {
	st := mem.New()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg, _ := config.LoadDefaults()
	cfg.Pricing.PGFallback = false
	pr := pricing.NewService(cfg.Pricing, cfg.Quota.ReserveTokens, st, nil, log)
	dir := t.TempDir()
	writePricing(t, dir)
	cfg.Pricing.ConfigMapPath = dir + "/pricing.yaml"
	pr = pricing.NewService(cfg.Pricing, cfg.Quota.ReserveTokens, st, nil, log)
	require.NoError(t, pr.Start(context.Background(), time.Minute))
	defer pr.Stop()
	q := quota.NewService(cfg.Quota, st, nil, log)

	limit := int64(5_000_000)
	acct, _ := st.CreateAccount(context.Background(), store.Account{ID: uuid.New(), Name: "alice", Group: "default", Status: "active", QuotaLimit: &limit})
	key, _ := st.CreateKey(context.Background(), store.Key{ID: uuid.New(), AccountID: acct.ID, Name: "k", KeyHash: "h", KeyPreview: "p", Status: "active", QuotaLimit: &limit}, nil)
	card, _ := pr.Lookup(context.Background(), "lab-model", "default")
	_, err := q.Reserve(context.Background(), key, card, "req-1", time.Now())
	require.NoError(t, err)

	ing := NewIngest(cfg.Billing, st, pr, nil, log, NewResolver(st, time.Minute))
	inserted, err := ing.Settle(context.Background(), Record{RequestID: "req-1", KeyID: key.ID, Model: "lab-model", InputTokens: 1000, OutputTokens: 500, CachedTokens: 200})
	require.NoError(t, err)
	assert.True(t, inserted)

	k, _ := st.GetKey(context.Background(), key.ID)
	assert.Equal(t, int64(1_820_000), k.QuotaUsed)
	assert.Equal(t, int64(0), k.Reserved)
	a, _ := st.GetAccount(context.Background(), acct.ID)
	assert.Equal(t, int64(1_820_000), a.QuotaUsed)
	assert.Equal(t, int64(0), a.Reserved)
	_, err = st.GetReservation(context.Background(), "req-1")
	assert.ErrorIs(t, err, loom.ErrNotFound)

	// 重复投递：不重复扣费
	inserted, err = ing.Settle(context.Background(), Record{RequestID: "req-1", KeyID: key.ID, Model: "lab-model", InputTokens: 1000, OutputTokens: 500, CachedTokens: 200})
	require.NoError(t, err)
	assert.False(t, inserted)
	k, _ = st.GetKey(context.Background(), key.ID)
	assert.Equal(t, int64(1_820_000), k.QuotaUsed)

	// 无预扣记录：直接累加
	inserted, err = ing.Settle(context.Background(), Record{RequestID: "req-2", KeyID: key.ID, Model: "lab-model", InputTokens: 1000, OutputTokens: 500, CachedTokens: 200})
	require.NoError(t, err)
	assert.True(t, inserted)
	k, _ = st.GetKey(context.Background(), key.ID)
	assert.Equal(t, int64(3_640_000), k.QuotaUsed)
}

func writePricing(t *testing.T, dir string) {
	t.Helper()
	require.NoError(t, os.WriteFile(dir+"/pricing.yaml", []byte("models:\n  lab-model: {model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1}\n"), 0o644))
}
