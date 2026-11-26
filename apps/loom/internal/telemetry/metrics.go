package telemetry

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Metrics 汇总 loom 所有自定义指标；所有 counter/gauge 以 loom_ 前缀。
type Metrics struct {
	BuildInfo           *prometheus.GaugeVec
	AuthDecisions       *prometheus.CounterVec
	AuthDuration        *prometheus.HistogramVec
	AuthCacheHits       *prometheus.CounterVec
	PricingLookups      *prometheus.CounterVec
	PricingReload       *prometheus.CounterVec
	PricingModels       prometheus.Gauge
	QuotaReserved       *prometheus.CounterVec
	QuotaSettled        *prometheus.CounterVec
	QuotaRemaining      *prometheus.GaugeVec
	ReservationsOpen    prometheus.Gauge
	ReservationsExpired prometheus.Counter
	UsageIngested       *prometheus.CounterVec
	IngestErrors        *prometheus.CounterVec
	IngestQueueDepth    prometheus.Gauge
	IngestFlushDuration prometheus.Histogram
	IngestDropped       prometheus.Counter
	IngestTraces        prometheus.Counter
	RLSCalls            *prometheus.CounterVec
	UsageSettled        *prometheus.CounterVec
	CostMismatch        *prometheus.CounterVec
	PGAcquires          prometheus.Counter
	PGAcquireDuration   prometheus.Histogram
	PGErrors            *prometheus.CounterVec
	Registry            *prometheus.Registry
}

// NewMetrics 创建指标集并注册 go/process collector。
func NewMetrics(version, commit string) *Metrics {
	m := &Metrics{
		BuildInfo:           prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "loom_build_info", Help: "Build version."}, []string{"version", "commit"}),
		AuthDecisions:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_auth_decisions_total", Help: "Authentication decisions."}, []string{"source", "reason", "allowed"}),
		AuthDuration:        prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "loom_auth_duration_seconds", Help: "Authentication latency by stage.", Buckets: prometheus.DefBuckets}, []string{"stage"}),
		AuthCacheHits:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_auth_cache_hits_total", Help: "Cache lookups by type and result."}, []string{"type", "result"}),
		PricingLookups:      prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_pricing_lookups_total", Help: "Pricing lookups by source."}, []string{"source"}),
		PricingReload:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_pricing_reload_total", Help: "ConfigMap pricing reload attempts."}, []string{"result"}),
		PricingModels:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "loom_pricing_models", Help: "Models loaded from ConfigMap."}),
		QuotaReserved:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_quota_reserved_nanos_total", Help: "Nano-USD reserved at auth time."}, []string{"model"}),
		QuotaSettled:        prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_quota_settled_nanos_total", Help: "Nano-USD actually charged at settle time."}, []string{"model"}),
		QuotaRemaining:      prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "loom_quota_remaining_nanos", Help: "Remaining account quota (unlimited accounts omitted)."}, []string{"account"}),
		ReservationsOpen:    prometheus.NewGauge(prometheus.GaugeOpts{Name: "loom_reservations_open", Help: "Open (unsettled) reservations."}),
		ReservationsExpired: prometheus.NewCounter(prometheus.CounterOpts{Name: "loom_reservations_expired_total", Help: "Reservations released by the reaper."}),
		UsageIngested:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_usage_events_ingested_total", Help: "Usage events stored."}, []string{"pricing_source", "settled"}),
		IngestErrors:        prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_ingest_errors_total", Help: "Ingest failures."}, []string{"reason"}),
		IngestQueueDepth:    prometheus.NewGauge(prometheus.GaugeOpts{Name: "loom_ingest_queue_depth", Help: "Pending usage records in queue."}),
		IngestFlushDuration: prometheus.NewHistogram(prometheus.HistogramOpts{Name: "loom_ingest_flush_duration_seconds", Help: "Batch flush latency."}),
		IngestDropped:       prometheus.NewCounter(prometheus.CounterOpts{Name: "loom_ingest_dropped_total", Help: "Records dropped because the queue was full."}),
		IngestTraces:        prometheus.NewCounter(prometheus.CounterOpts{Name: "loom_ingest_traces_total", Help: "Trace spans received (counted only)."}),
		RLSCalls:            prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_rls_calls_total", Help: "RateLimitService calls by type: check (request phase, no charge) or amend (settlement)."}, []string{"type"}),
		UsageSettled:        prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_usage_settled_total", Help: "Settlement attempts by channel (rls/otlp); inserted=false means the idempotency key already existed."}, []string{"channel", "inserted"}),
		CostMismatch:        prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_cost_mismatch_total", Help: "Requests where loom cost differs from gateway realized cost."}, []string{"model"}),
		PGAcquires:          prometheus.NewCounter(prometheus.CounterOpts{Name: "loom_pg_pool_acquires_total", Help: "Pool acquisitions."}),
		PGAcquireDuration:   prometheus.NewHistogram(prometheus.HistogramOpts{Name: "loom_pg_acquire_duration_seconds", Help: "Pool acquisition latency.", Buckets: []float64{0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1}}),
		PGErrors:            prometheus.NewCounterVec(prometheus.CounterOpts{Name: "loom_pg_errors_total", Help: "PostgreSQL errors by operation."}, []string{"op"}),
		Registry:            prometheus.NewRegistry(),
	}
	m.BuildInfo.WithLabelValues(version, commit).Set(1)
	m.Registry.MustRegister(
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.BuildInfo, m.AuthDecisions, m.AuthDuration, m.AuthCacheHits, m.PricingLookups, m.PricingReload, m.PricingModels,
		m.QuotaReserved, m.QuotaSettled, m.QuotaRemaining, m.ReservationsOpen, m.ReservationsExpired,
		m.UsageIngested, m.IngestErrors, m.IngestQueueDepth, m.IngestFlushDuration, m.IngestDropped, m.IngestTraces, m.RLSCalls, m.UsageSettled,
		m.CostMismatch, m.PGAcquires, m.PGAcquireDuration, m.PGErrors,
	)
	return m
}
