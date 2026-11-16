package billing

import (
	"context"
	"log"
	"net"

	colllogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collmetrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	colltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	"google.golang.org/grpc"
	"sync"
)

var debugOnce sync.Once

// OTGRPCServer accepts native OTLP/gRPC from agentgateway (protocol: GRPC on
// frontend.accessLog.otlp / frontend.tracing.otlp), so no OpenTelemetry
// Collector is required to prove the pipeline in the lab.
type OTGRPCServer struct {
	Service *Service
}

func (s *OTGRPCServer) Serve(addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := grpc.NewServer()
	colllogs.RegisterLogsServiceServer(srv, &logsServer{svc: s.Service})
	collmetrics.RegisterMetricsServiceServer(srv, &metricsServer{svc: s.Service})
	colltrace.RegisterTraceServiceServer(srv, &tracesServer{svc: s.Service})
	log.Printf("finops OTLP/gRPC ingest listening on %s", addr)
	return srv.Serve(lis)
}

type logsServer struct {
	colllogs.UnimplementedLogsServiceServer
	svc *Service
}

func (l *logsServer) Export(ctx context.Context, req *colllogs.ExportLogsServiceRequest) (*colllogs.ExportLogsServiceResponse, error) {
	ingested := 0
	for _, rl := range req.GetResourceLogs() {
		res := attrsFromPB(rl.GetResource().GetAttributes())
		for _, sl := range rl.GetScopeLogs() {
			for _, rec := range sl.GetLogRecords() {
				u := UsageFromAttrs(attrsFromPB(rec.GetAttributes()), res)
				if u.Model == "" && u.InputTokens == 0 && u.OutputTokens == 0 {
					continue
				}
				if err := l.svc.persist(ctx, u); err != nil {
					return nil, err
				}
				// The first record is logged verbatim: it is the only reliable way
				// to see which attribute names the gateway actually emitted.
				debugOnce.Do(func() {
					log.Printf("otlp log first record attrs=%v resource=%v", attrsFromPB(rec.GetAttributes()), res)
				})
				log.Printf("otlp log: client=%q model=%q in=%d out=%d cached=%d",
					u.ClientID, u.Model, u.InputTokens, u.OutputTokens, u.CachedTokens)
				ingested++
			}
		}
	}
	log.Printf("otlp/grpc logs: ingested=%d", ingested)
	return &colllogs.ExportLogsServiceResponse{}, nil
}

type metricsServer struct {
	collmetrics.UnimplementedMetricsServiceServer
	svc *Service
}

func (m *metricsServer) Export(ctx context.Context, req *collmetrics.ExportMetricsServiceRequest) (*collmetrics.ExportMetricsServiceResponse, error) {
	usages := usageFromMetricsPB(req)
	for _, u := range usages {
		if err := m.svc.persist(ctx, u); err != nil {
			return nil, err
		}
	}
	log.Printf("otlp/grpc metrics: ingested=%d", len(usages))
	return &collmetrics.ExportMetricsServiceResponse{}, nil
}

func usageFromMetricsPB(req *collmetrics.ExportMetricsServiceRequest) []Usage {
	var out []Usage
	for _, rm := range req.GetResourceMetrics() {
		res := attrsFromPB(rm.GetResource().GetAttributes())
		for _, sm := range rm.GetScopeMetrics() {
			for _, m := range sm.GetMetrics() {
				sum := m.GetSum()
				if sum == nil {
					continue
				}
				if m.GetName() != "gen_ai.client.token.usage" && m.GetName() != "agw.ai.usage.tokens" {
					continue
				}
				for _, dp := range sum.GetDataPoints() {
					a := attrsFromPB(dp.GetAttributes())
					u := Usage{
						RequestID: a.First("agw.request.id", "request_id"),
						ClientID:  a.First("agw.client.id", "client_id", "api_key.client_id"),
						Tenant:    a.First("agw.tenant.id", "tenant_id"),
						Model:     a.First("gen_ai.request.model", "agw.ai.model", "model"),
						Provider:  a.First("gen_ai.provider.name", "agw.ai.provider"),
					}
					if u.Model == "" {
						u.Model = res.First("gen_ai.request.model", "agw.ai.model", "model")
					}
					if u.ClientID == "" {
						u.ClientID = res.First("client_id", "agw.client.id")
					}
					switch a.First("gen_ai.token.type", "token_type") {
					case "input", "prompt":
						u.InputTokens = dp.GetAsInt()
					case "output", "completion":
						u.OutputTokens = dp.GetAsInt()
					}
					u.CachedTokens = a.IntFirst("gen_ai.usage.cache_read_input_tokens",
						"gen_ai.usage.cache_read.input_tokens", "cached_tokens")
					out = append(out, u)
				}
			}
		}
	}
	return out
}

// attrsFromPB flattens OTLP AnyValue attributes into the same string map the
// JSON decoder produces, so both transports share one mapping implementation.
func attrsFromPB(kvs []*commonpb.KeyValue) Attrs {
	out := Attrs{}
	for _, kv := range kvs {
		out[kv.GetKey()] = anyValueString(kv.GetValue())
	}
	return out
}

func anyValueString(v *commonpb.AnyValue) string {
	switch val := v.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return val.StringValue
	case *commonpb.AnyValue_IntValue:
		return itoa(val.IntValue)
	case *commonpb.AnyValue_DoubleValue:
		return ftoa(val.DoubleValue)
	case *commonpb.AnyValue_BoolValue:
		if val.BoolValue {
			return "true"
		}
		return "false"
	}
	return ""
}
