package billing

import (
	"context"

	logspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
)

// LogsServer 实现 OTLP LogsService：网关 access log 的入口。
type LogsServer struct {
	logspb.UnimplementedLogsServiceServer
	ingest *Ingest
	attrs  config.AttributeMap
}

// NewLogsServer 创建 LogsService。
func NewLogsServer(ingest *Ingest, attrs config.AttributeMap) *LogsServer {
	return &LogsServer{ingest: ingest, attrs: attrs}
}

// Export 见 opentelemetry.proto.collector.logs.v1.LogsService/Export。
func (s *LogsServer) Export(ctx context.Context, req *logspb.ExportLogsServiceRequest) (*logspb.ExportLogsServiceResponse, error) {
	n := 0
	for _, rl := range req.GetResourceLogs() {
		res := rl.GetResource().GetAttributes()
		for _, sl := range rl.GetScopeLogs() {
			for _, lr := range sl.GetLogRecords() {
				rec := RecordFromLogRecord(lr, res, s.attrs)
				rec.Channel = "otlp"
				if s.ingest.Queue(rec) {
					n++
				}
			}
		}
	}
	if n > 0 {
		s.ingest.log.Debug("otlp logs accepted", "records", n)
	}
	return &logspb.ExportLogsServiceResponse{}, nil
}

// TracesServer 实现 OTLP TraceService：只计数，不参与计费。
type TracesServer struct {
	tracepb.UnimplementedTraceServiceServer
	ingest *Ingest
}

// NewTracesServer 创建 TraceService。
func NewTracesServer(ingest *Ingest) *TracesServer { return &TracesServer{ingest: ingest} }

// Export 见 TraceService/Export。
func (s *TracesServer) Export(ctx context.Context, req *tracepb.ExportTraceServiceRequest) (*tracepb.ExportTraceServiceResponse, error) {
	n := 0
	for _, rs := range req.GetResourceSpans() {
		for _, ss := range rs.GetScopeSpans() {
			n += len(ss.GetSpans())
		}
	}
	if s.ingest.m != nil {
		s.ingest.m.IngestTraces.Add(float64(n))
	}
	return &tracepb.ExportTraceServiceResponse{}, nil
}
