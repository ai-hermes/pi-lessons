// Package otlp 接收网关 OTLP access log 作为结算的补账通道：
// 与 ratelimit 同步通道共用 request_id 幂等键，先到先结算，后到的只补写网关金额。
// trace 只计数，不参与计费。
package otlp

import (
	"context"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/google/uuid"
	logsv1 "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/ledger"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// Channel 是本通道在结算记录中的名称。
const Channel = "otlp"

// Attributes 是 access log 属性名映射（以网关实际输出为准）。
type Attributes struct {
	InputTokens  string
	OutputTokens string
	CachedTokens string
	GatewayCost  string // 网关按 modelCatalog 算出的 USD 金额
	Model        string // gen_ai.request.model；非 LLM 路由为空
	LoomModel    string // extauth 注入的模型名，Model 为空时使用
	Provider     string
	Protocol     string
	Route        string
	Gateway      string
	RequestID    string
	KeyID        string
	Account      string
}

// LogsServer 实现 OTLP LogsService：解析 access log 并交给补账队列。
type LogsServer struct {
	logsv1.UnimplementedLogsServiceServer
	queue *Queue
	attrs Attributes
}

// NewLogsServer 创建 LogsService。
func NewLogsServer(queue *Queue, attrs Attributes) *LogsServer {
	return &LogsServer{queue: queue, attrs: attrs}
}

// Export 见 opentelemetry.proto.collector.logs.v1.LogsService/Export。
func (s *LogsServer) Export(
	_ context.Context,
	req *logsv1.ExportLogsServiceRequest,
) (*logsv1.ExportLogsServiceResponse, error) {
	for _, rl := range req.GetResourceLogs() {
		resource := rl.GetResource().GetAttributes()
		for _, sl := range rl.GetScopeLogs() {
			for _, record := range sl.GetLogRecords() {
				usage, protocol := s.attrs.usage(record, resource)
				s.queue.enqueue(usage, protocol)
			}
		}
	}
	return &logsv1.ExportLogsServiceResponse{}, nil
}

// TracesServer 实现 OTLP TraceService：只计数。
type TracesServer struct {
	tracev1.UnimplementedTraceServiceServer
	metrics *telemetry.Metrics
}

// NewTracesServer 创建 TraceService。
func NewTracesServer(metrics *telemetry.Metrics) *TracesServer {
	return &TracesServer{metrics: metrics}
}

// Export 见 opentelemetry.proto.collector.trace.v1.TraceService/Export。
func (s *TracesServer) Export(
	_ context.Context,
	req *tracev1.ExportTraceServiceRequest,
) (*tracev1.ExportTraceServiceResponse, error) {
	spans := 0
	for _, rs := range req.GetResourceSpans() {
		for _, ss := range rs.GetScopeSpans() {
			spans += len(ss.GetSpans())
		}
	}
	s.metrics.OTLPSpans.Add(float64(spans))
	return &tracev1.ExportTraceServiceResponse{}, nil
}

// usage 把一条 access log 转为用量上报；资源属性与记录属性合并，记录属性优先。
func (a Attributes) usage(record *logspb.LogRecord, resource []*commonpb.KeyValue) (ledger.Usage, string) {
	attrs := attributeMap(resource)
	for k, v := range attributeMap(record.GetAttributes()) {
		attrs[k] = v
	}

	u := ledger.Usage{
		RequestID:   attrs.str(a.RequestID),
		Channel:     Channel,
		AccountName: attrs.str(a.Account),
		Model:       attrs.str(a.Model),
		Tokens: pricing.Tokens{
			Input:  attrs.int(a.InputTokens),
			Cached: attrs.int(a.CachedTokens),
			Output: attrs.int(a.OutputTokens),
		},
		Provider: attrs.str(a.Provider),
		Route:    attrs.str(a.Route),
		Gateway:  attrs.str(a.Gateway),
		Time:     recordTime(record),
		TraceID:  hexID(record.GetTraceId(), 16),
		SpanID:   hexID(record.GetSpanId(), 8),
	}
	if u.Model == "" {
		u.Model = attrs.str(a.LoomModel)
	}
	if id, err := uuid.Parse(attrs.str(a.KeyID)); err == nil {
		u.KeyID = id
	}
	if usd, ok := attrs.float(a.GatewayCost); ok {
		nanos := int64(usd*float64(pricing.NanosPerUSD) + 0.5)
		u.GatewayCostNanos = &nanos
	}
	return u, attrs.str(a.Protocol)
}

func recordTime(r *logspb.LogRecord) time.Time {
	ts := r.GetTimeUnixNano()
	if ts == 0 {
		ts = r.GetObservedTimeUnixNano()
	}
	if ts == 0 {
		return time.Time{}
	}
	return time.Unix(0, int64(ts))
}

func hexID(b []byte, size int) string {
	if len(b) != size {
		return ""
	}
	return hex.EncodeToString(b)
}

// attributes 是 OTLP 属性的扁平视图。
type attributes map[string]any

func attributeMap(kvs []*commonpb.KeyValue) attributes {
	m := make(attributes, len(kvs))
	for _, kv := range kvs {
		switch v := kv.GetValue().GetValue().(type) {
		case *commonpb.AnyValue_StringValue:
			m[kv.GetKey()] = v.StringValue
		case *commonpb.AnyValue_IntValue:
			m[kv.GetKey()] = v.IntValue
		case *commonpb.AnyValue_DoubleValue:
			m[kv.GetKey()] = v.DoubleValue
		case *commonpb.AnyValue_BoolValue:
			m[kv.GetKey()] = v.BoolValue
		}
	}
	return m
}

func (m attributes) str(key string) string {
	switch v := m[key].(type) {
	case string:
		return v
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

func (m attributes) int(key string) int64 {
	switch v := m[key].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	}
	return 0
}

func (m attributes) float(key string) (float64, bool) {
	switch v := m[key].(type) {
	case float64:
		return v, true
	case int64:
		return float64(v), true
	case string:
		f, err := strconv.ParseFloat(v, 64)
		return f, err == nil
	}
	return 0, false
}
