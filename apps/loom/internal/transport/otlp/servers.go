// Package otlp 接收网关 OTLP access log 作为结算的补账通道：
// 与 ratelimit 同步通道共用 request_id 幂等键，先到先结算，后到的只补写网关金额。
// trace 只计数，不参与计费。
package otlp

import (
	"context"
	"encoding/hex"
	"maps"
	"math"
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

// AttributeNames 是 access log 属性名映射（以网关实际输出为准）。
type AttributeNames struct {
	InputTokens      string
	OutputTokens     string
	CachedTokens     string
	AgentGatewayCost string // 网关按 modelCatalog 算出的 USD 金额
	Model            string // gen_ai.request.model；非 LLM 路由为空
	LoomModel        string // extauth 注入的模型名，Model 为空时使用
	Provider         string
	Protocol         string
	Route            string
	AgentGateway     string
	RequestID        string
	APIKeyID         string
	Account          string
	Status           string // 响应状态码
}

// LogsServer 实现 OTLP LogsService：解析 access log 并交给补账队列。
type LogsServer struct {
	logsv1.UnimplementedLogsServiceServer
	queue          *Queue
	attributeNames AttributeNames
}

// NewLogsServer 创建 LogsService。
func NewLogsServer(queue *Queue, attributeNames AttributeNames) *LogsServer {
	return &LogsServer{queue: queue, attributeNames: attributeNames}
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
				report, protocol := s.attributeNames.usageReport(record, resource)
				s.queue.enqueue(report, protocol)
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

// usageReport 把一条 access log 转为用量上报；资源属性与记录属性合并，记录属性优先。
func (a AttributeNames) usageReport(
	record *logspb.LogRecord,
	resource []*commonpb.KeyValue,
) (ledger.UsageReport, string) {
	values := attributeMap(resource)
	maps.Copy(values, attributeMap(record.GetAttributes()))

	report := ledger.UsageReport{
		RequestID:   values.str(a.RequestID),
		Channel:     Channel,
		AccountName: values.str(a.Account),
		Model:       values.str(a.Model),
		TokenUsage: pricing.TokenUsage{
			Input:  values.int(a.InputTokens),
			Cached: values.int(a.CachedTokens),
			Output: values.int(a.OutputTokens),
		},
		Provider:     values.str(a.Provider),
		Route:        values.str(a.Route),
		AgentGateway: values.str(a.AgentGateway),
		Status:       int(values.int(a.Status)),
		Time:         recordTime(record),
		TraceID:      hexID(record.GetTraceId(), 16),
		SpanID:       hexID(record.GetSpanId(), 8),
	}
	if report.Model == "" {
		report.Model = values.str(a.LoomModel)
	}
	if id, err := uuid.Parse(values.str(a.APIKeyID)); err == nil {
		report.APIKeyID = id
	}
	if usd, ok := values.float(a.AgentGatewayCost); ok {
		nanos := int64(usd*float64(pricing.NanosPerUSD) + 0.5)
		report.AgentGatewayCostNanos = &nanos
	}
	return report, values.str(a.Protocol)
}

func recordTime(r *logspb.LogRecord) time.Time {
	ts := r.GetTimeUnixNano()
	if ts == 0 {
		ts = r.GetObservedTimeUnixNano()
	}
	if ts == 0 || ts > math.MaxInt64 {
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
type attributeValues map[string]any

func attributeMap(kvs []*commonpb.KeyValue) attributeValues {
	values := make(attributeValues, len(kvs))
	for _, kv := range kvs {
		switch v := kv.GetValue().GetValue().(type) {
		case *commonpb.AnyValue_StringValue:
			values[kv.GetKey()] = v.StringValue
		case *commonpb.AnyValue_IntValue:
			values[kv.GetKey()] = v.IntValue
		case *commonpb.AnyValue_DoubleValue:
			values[kv.GetKey()] = v.DoubleValue
		case *commonpb.AnyValue_BoolValue:
			values[kv.GetKey()] = v.BoolValue
		}
	}
	return values
}

func (values attributeValues) str(name string) string {
	switch value := values[name].(type) {
	case string:
		return value
	case int64:
		return strconv.FormatInt(value, 10)
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	return ""
}

func (values attributeValues) int(name string) int64 {
	switch value := values[name].(type) {
	case int64:
		return value
	case float64:
		return int64(value)
	case string:
		n, _ := strconv.ParseInt(value, 10, 64)
		return n
	}
	return 0
}

func (values attributeValues) float(name string) (float64, bool) {
	switch value := values[name].(type) {
	case float64:
		return value, true
	case int64:
		return float64(value), true
	case string:
		f, err := strconv.ParseFloat(value, 64)
		return f, err == nil
	}
	return 0, false
}
