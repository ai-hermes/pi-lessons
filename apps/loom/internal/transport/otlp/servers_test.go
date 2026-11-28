package otlp

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
)

var testAttributeNames = AttributeNames{
	InputTokens:      "gen_ai.usage.input_tokens",
	OutputTokens:     "gen_ai.usage.output_tokens",
	CachedTokens:     "gen_ai.usage.cache_read.input_tokens",
	AgentGatewayCost: "agw.ai.usage.cost.total",
	Model:            "gen_ai.request.model",
	LoomModel:        "loom.model",
	Provider:         "gen_ai.provider.name",
	Protocol:         "protocol",
	RequestID:        "loom.request.id",
	APIKeyID:         "loom.key.id",
	Account:          "loom.client.id",
	Status:           "http.status",
	UsageEstimated:   "agw.ai.usage.estimated",
}

func kv(key string, v any) *commonpb.KeyValue {
	var value *commonpb.AnyValue
	switch x := v.(type) {
	case string:
		value = &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: x}}
	case int64:
		value = &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: x}}
	case float64:
		value = &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: x}}
	case bool:
		value = &commonpb.AnyValue{Value: &commonpb.AnyValue_BoolValue{BoolValue: x}}
	}
	return &commonpb.KeyValue{Key: key, Value: value}
}

func TestAccessLogToUsageReport(t *testing.T) {
	record := &logspb.LogRecord{
		TimeUnixNano: 1_700_000_000_000_000_000,
		TraceId:      make([]byte, 16),
		SpanId:       []byte{1, 2, 3, 4, 5, 6, 7, 8},
		Attributes: []*commonpb.KeyValue{
			kv("gen_ai.usage.input_tokens", int64(1000)),
			kv("gen_ai.usage.output_tokens", int64(500)),
			kv("gen_ai.usage.cache_read.input_tokens", int64(200)),
			kv("agw.ai.usage.cost.total", 0.00182),
			kv("gen_ai.request.model", "lab-model"),
			kv("loom.request.id", "req-1"),
			kv("loom.client.id", "alice"),
			kv("loom.key.id", "11111111-2222-3333-4444-555555555555"),
			kv("protocol", "llm"),
			kv("http.status", int64(200)),
			kv("agw.ai.usage.estimated", true),
		},
	}

	u, protocol := testAttributeNames.usageReport(record, nil)
	assert.Equal(t, 200, u.Status)
	assert.True(t, u.UsageEstimated)

	assert.Equal(t, "llm", protocol)
	assert.Equal(t, Channel, u.Channel)
	assert.Equal(t, "req-1", u.RequestID)
	assert.Equal(t, "alice", u.AccountName)
	assert.Equal(t, "11111111-2222-3333-4444-555555555555", u.APIKeyID.String())
	assert.Equal(t, pricing.TokenUsage{Input: 1000, Cached: 200, Output: 500}, u.TokenUsage)
	require.NotNil(t, u.AgentGatewayCostNanos)
	assert.Equal(t, int64(1_820_000), *u.AgentGatewayCostNanos)
	assert.Len(t, u.TraceID, 32)
	assert.Equal(t, "0102030405060708", u.SpanID)
}

func TestAccessLogFallsBackToLoomModel(t *testing.T) {
	record := &logspb.LogRecord{Attributes: []*commonpb.KeyValue{kv("loom.model", "lab-image")}}

	u, _ := testAttributeNames.usageReport(record, nil)

	assert.Equal(t, "lab-image", u.Model)
}
