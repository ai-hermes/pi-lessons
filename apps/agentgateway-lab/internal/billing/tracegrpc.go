package billing

import (
	"context"
	"encoding/hex"
	"log"
	"math"
	"sync"
	"time"

	colltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

// Trace ingest is the audit-trail half of the telemetry story: spans are kept
// verbatim (JSON) so a dispute can be answered with the exact request
// waterfall, while billing itself stays on access-log usage events.
var traceOnce sync.Once

// EnsureTraceSchema is idempotent: the lab runs PostgreSQL on emptyDir, so the
// table must be created by the app instead of a one-shot init script.
func (s *Store) EnsureTraceSchema(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS traces (
  received_at timestamptz NOT NULL DEFAULT now(),
  trace_id    text NOT NULL,
  span_id     text NOT NULL,
  name        text,
  service     text,
  route       text,
  client_id   text,
  model       text,
  duration_ms bigint,
  status_code bigint,
  attrs       jsonb,
  cost_micros bigint DEFAULT 0,
  input_tokens bigint DEFAULT 0,
  output_tokens bigint DEFAULT 0,
  PRIMARY KEY (trace_id, span_id)
);
ALTER TABLE traces ADD COLUMN IF NOT EXISTS cost_micros bigint DEFAULT 0;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS input_tokens bigint DEFAULT 0;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS output_tokens bigint DEFAULT 0;`)
	return err
}

func (s *Store) InsertTrace(ctx context.Context, t TraceRow) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO traces (trace_id, span_id, name, service, route, client_id, model, duration_ms, status_code, attrs, cost_micros, input_tokens, output_tokens)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT (trace_id, span_id) DO NOTHING`,
		t.TraceID, t.SpanID, t.Name, t.Service, t.Route, t.ClientID, t.Model, t.DurationMS, t.StatusCode, t.AttrsJSON,
		t.CostMicros, t.InputTokens, t.OutputTokens)
	return err
}

// TraceRow is one flattened span; span-level duplicate suppression keeps
// re-exports (retries) idempotent.
type TraceRow struct {
	TraceID      string
	SpanID       string
	Name         string
	Service      string
	Route        string
	ClientID     string
	Model        string
	DurationMS   int64
	StatusCode   int64
	AttrsJSON    string
	CostMicros   int64
	InputTokens  int64
	OutputTokens int64
}

func (s *Store) TraceCount(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM traces`).Scan(&n)
	return n, err
}

type tracesServer struct {
	colltrace.UnimplementedTraceServiceServer
	svc *Service
}

func (t *tracesServer) Export(ctx context.Context, req *colltrace.ExportTraceServiceRequest) (*colltrace.ExportTraceServiceResponse, error) {
	traceOnce.Do(func() {
		if err := t.svc.Store.EnsureTraceSchema(ctx); err != nil {
			log.Printf("ensure traces schema: %v", err)
		}
	})
	n := 0
	for _, rs := range req.GetResourceSpans() {
		res := attrsFromPB(rs.GetResource().GetAttributes())
		service := res.First("service.name")
		for _, ss := range rs.GetScopeSpans() {
			for _, span := range ss.GetSpans() {
				a := attrsFromPB(span.GetAttributes())
				start := span.GetStartTimeUnixNano()
				end := span.GetEndTimeUnixNano()
				dur := int64(0)
				if end > start {
					dur = int64(time.Duration(end-start) / time.Millisecond)
				}
				row := TraceRow{
					TraceID:      hexID(span.GetTraceId()),
					SpanID:       hexID(span.GetSpanId()),
					Name:         span.GetName(),
					Service:      service,
					Route:        a.First("route", "http.route"),
					ClientID:     a.First("lab.client.id", "x-client-id", "api_key.client_id"),
					Model:        a.First("gen_ai.request.model", "agw.ai.request.model"),
					DurationMS:   dur,
					StatusCode:   a.IntFirst("http.response.status_code", "http.status"),
					CostMicros:   costMicros(a),
					InputTokens:  a.IntFirst("gen_ai.usage.input_tokens"),
					OutputTokens: a.IntFirst("gen_ai.usage.output_tokens"),
					AttrsJSON:    marshalSpan(span),
				}
				if err := t.svc.Store.InsertTrace(ctx, row); err != nil {
					log.Printf("insert trace: %v", err)
					continue
				}
				n++
			}
		}
	}
	log.Printf("otlp/grpc traces: ingested=%d", n)
	return &colltrace.ExportTraceServiceResponse{}, nil
}

func marshalSpan(span *tracepb.Span) string {
	b, err := protojson.Marshal(span)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// hexID renders the native 16/8-byte trace and span identifiers as the hex
// strings every tracing backend uses.
func hexID(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return hex.EncodeToString(b)
}

// TracePreview returns the most recent spans for the audit endpoint.
func (s *Store) TracePreview(ctx context.Context, limit int) ([]map[string]any, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	rows, err := s.pool.Query(ctx, `
SELECT to_char(received_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), trace_id, name, coalesce(service,''),
       coalesce(route,''), coalesce(client_id,''), coalesce(model,''), duration_ms, cost_micros,
       input_tokens, output_tokens
FROM traces ORDER BY received_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var at, traceID, name, service, route, client, model string
		var dur, cost, inTok, outTok int64
		if err := rows.Scan(&at, &traceID, &name, &service, &route, &client, &model, &dur, &cost, &inTok, &outTok); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"received_at": at, "trace_id": traceID, "name": name, "service": service,
			"route": route, "client_id": client, "model": model, "duration_ms": dur,
			"cost_usd": float64(cost) / 1e6, "input_tokens": inTok, "output_tokens": outTok,
		})
	}
	return out, rows.Err()
}

// costMicros reads the gateway-computed realized cost (USD float) as micros.
func costMicros(a Attrs) int64 {
	if v, ok := a.FloatFirst("agw.ai.usage.cost.total"); ok {
		return int64(math.Round(v * 1e6))
	}
	return 0
}
