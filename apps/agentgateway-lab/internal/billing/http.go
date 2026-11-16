package billing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Service wires the OTLP ingestion endpoints and the chargeback API.
type Service struct {
	Store      *Store
	AdminToken string
}

func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	// agentgateway's accessLog.otlp and tracing.otlp target these paths when
	// an OTel Collector (or the gateway itself) speaks OTLP/HTTP JSON.
	mux.HandleFunc("/v1/logs", s.ingestLogs)
	mux.HandleFunc("/v1/metrics", s.ingestMetrics)
	mux.HandleFunc("/v1/usage/summary", s.summary)
	mux.HandleFunc("/v1/usage/chargeback", s.summary)
	mux.HandleFunc("/v1/traces/summary", s.traces)
	mux.HandleFunc("/admin/simulate", s.simulate)
	return mux
}

func (s *Service) ingestLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	req, err := ParseLogs(readBody(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ingested := 0
	for _, rl := range req.ResourceLogs {
		res := Flatten(rl.Resource.Attributes)
		for _, sl := range rl.ScopeLogs {
			for _, rec := range sl.LogRecords {
				u := MapLogRecord(rec, res)
				if u.Model == "" && u.InputTokens == 0 && u.OutputTokens == 0 {
					// Access-log records without LLM usage (plain HTTP proxying)
					// are not billable; they are still visible in gateway logs.
					continue
				}
				if err := s.persist(r.Context(), u); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				ingested++
			}
		}
	}
	writeJSON(w, map[string]any{"ingested": ingested})
}

func (s *Service) ingestMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	req, err := ParseMetrics(readBody(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	usages := UsageFromMetrics(req)
	for _, u := range usages {
		if err := s.persist(r.Context(), u); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	writeJSON(w, map[string]any{"ingested": len(usages)})
}

func (s *Service) persist(ctx context.Context, u Usage) error {
	var price *Price
	if u.Model != "" {
		if p, err := s.Store.Price(ctx, u.Model); err == nil {
			price = p
		}
	}
	cost := TotalCost(u, price)
	return s.Store.InsertUsage(ctx, u, cost)
}

func (s *Service) summary(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	since := time.Now().Add(-24 * time.Hour)
	switch {
	case q.Get("since") != "":
		if t, err := time.Parse(time.RFC3339, q.Get("since")); err == nil {
			since = t
		}
	case q.Get("month") != "":
		if t, err := time.Parse("2006-01", q.Get("month")); err == nil {
			since = t
		}
	case q.Get("days") != "":
		if n, err := strconv.Atoi(q.Get("days")); err == nil {
			since = time.Now().Add(-time.Duration(n) * 24 * time.Hour)
		}
	}
	rows, err := s.Store.Summarize(r.Context(), since, q.Get("tenant"), q.Get("client_id"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	total := int64(0)
	for _, row := range rows {
		total += row.RealizedCostMicros
	}
	writeJSON(w, map[string]any{
		"since":             since.UTC(),
		"rows":              rows,
		"total_cost_micros": total,
		"total_cost_usd":    float64(total) / 1_000_000,
	})
}

type simulateRequest struct {
	ClientID     string   `json:"client_id"`
	Tenant       string   `json:"tenant"`
	Model        string   `json:"model"`
	Provider     string   `json:"provider"`
	InputTokens  int64    `json:"input_tokens"`
	OutputTokens int64    `json:"output_tokens"`
	CachedTokens int64    `json:"cached_tokens"`
	CostUSD      *float64 `json:"cost_usd"`
}

// simulate exists because the lab has no billable LLM upstream: it exercises
// the exact ingestion + cost path with a payload shaped like a gateway access
// log, so chargeback math is verifiable without spending real tokens.
func (s *Service) simulate(w http.ResponseWriter, r *http.Request) {
	if s.AdminToken != "" && r.Header.Get("X-Admin-Token") != s.AdminToken {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body simulateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	u := Usage{
		RequestID: fmt.Sprintf("sim-%d", time.Now().UnixNano()),
		ClientID:  body.ClientID, Tenant: body.Tenant, Model: body.Model, Provider: body.Provider,
		InputTokens: body.InputTokens, OutputTokens: body.OutputTokens, CachedTokens: body.CachedTokens,
	}
	if body.CostUSD != nil {
		u.RealizedCostMicros = int64(*body.CostUSD * 1_000_000)
		u.HasRealizedCost = true
	}
	if err := s.persist(r.Context(), u); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"request_id": u.RequestID, "model": u.Model})
}

// readBody caps OTLP payloads at 8 MiB: a runaway collector should not be able
// to exhaust the billing service's memory.
func readBody(r *http.Request) []byte {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		return nil
	}
	return raw
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// traces exposes the audit trail: how many spans are retained and what the
// newest ones look like (identity, model, latency) without a tracing UI.
func (s *Service) traces(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	n, err := s.Store.TraceCount(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	rows, err := s.Store.TracePreview(ctx, 10)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, map[string]any{"spans": n, "recent": rows})
}
