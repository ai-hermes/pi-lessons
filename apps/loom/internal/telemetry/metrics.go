package telemetry

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Metrics 汇总 loom 的全部指标，按能力分组；所有指标以 loom_ 为前缀。
// 构造后各字段均非 nil，调用方无需判空。
type Metrics struct {
	Registry *prometheus.Registry

	// admission
	AdmissionDecisions *prometheus.CounterVec   // {reason, allowed}
	AdmissionDuration  *prometheus.HistogramVec // {stage}
	CacheLookups       *prometheus.CounterVec   // {cache, result}

	// cache sync
	CacheInvalidations  *prometheus.CounterVec // {kind, origin}
	CacheSyncReconnects prometheus.Counter

	// pricing
	PricingLookups *prometheus.CounterVec // {source}
	PricingReload  *prometheus.CounterVec // {result}
	PricingModels  prometheus.Gauge

	// ledger
	ReservedNanos        *prometheus.CounterVec // {model}
	SettledNanos         *prometheus.CounterVec // {model}
	Settlements          *prometheus.CounterVec // {channel, inserted}
	SettleErrors         *prometheus.CounterVec // {channel}
	RemainingNanos       *prometheus.GaugeVec   // {account}
	ReservationsOpen     prometheus.Gauge
	ReservationsExpired  prometheus.Counter
	ReserveCompensations *prometheus.CounterVec // {result}
	IncompleteResponses  *prometheus.CounterVec // {model}
	CostMismatch         *prometheus.CounterVec // {model}

	// throttle
	ThrottleRejections *prometheus.CounterVec // {scope, limit}

	// maintenance
	MaintenanceRuns        *prometheus.CounterVec // {task, result}
	MaintenanceLastSuccess *prometheus.GaugeVec   // {task}
	AuditAggregated        prometheus.Counter

	// transport
	RateLimitCalls    *prometheus.CounterVec // {phase}
	OTLPQueueDepth    prometheus.Gauge
	OTLPDropped       prometheus.Counter
	OTLPFlushDuration prometheus.Histogram
	OTLPSpans         prometheus.Counter

	// store
	StoreErrors *prometheus.CounterVec // {op}
}

// NewMetrics 创建指标集并注册 Go 运行时与进程指标。
func NewMetrics(version, commit string) *Metrics {
	m := &Metrics{
		Registry: prometheus.NewRegistry(),

		// admission
		AdmissionDecisions: counterVec(
			"loom_admission_decisions_total",
			"Admission verdicts.",
			"reason", "allowed",
		),
		AdmissionDuration: histogramVec(
			"loom_admission_duration_seconds",
			"Admission latency by stage.",
			"stage",
		),
		CacheInvalidations: counterVec(
			"loom_cache_invalidations_total",
			"Cache invalidations applied on this replica, by origin (local or remote replica).",
			"kind", "origin",
		),
		CacheSyncReconnects: counter(
			"loom_cache_sync_reconnects_total",
			"Reconnects of the cross-replica cache invalidation listener.",
		),
		CacheLookups: counterVec(
			"loom_cache_lookups_total",
			"In-process cache lookups.",
			"cache", "result",
		),

		// pricing
		PricingLookups: counterVec(
			"loom_pricing_lookups_total",
			"Price lookups by source.",
			"source",
		),
		PricingReload: counterVec(
			"loom_pricing_reloads_total",
			"pricing.yaml reload attempts.",
			"result",
		),
		PricingModels: gauge(
			"loom_pricing_models",
			"Models defined in pricing.yaml.",
		),

		// ledger
		ReservedNanos: counterVec(
			"loom_ledger_reserved_nanos_total",
			"Nano-USD reserved at admission.",
			"model",
		),
		SettledNanos: counterVec(
			"loom_ledger_settled_nanos_total",
			"Nano-USD charged at settlement.",
			"model",
		),
		Settlements: counterVec(
			"loom_ledger_settlements_total",
			"Settlement attempts; inserted=false means the request was already settled.",
			"channel", "inserted",
		),
		SettleErrors: counterVec(
			"loom_ledger_settle_errors_total",
			"Settlements that failed.",
			"channel",
		),
		RemainingNanos: gaugeVec(
			"loom_ledger_remaining_nanos",
			"Remaining quota of bounded accounts.",
			"account",
		),
		ReservationsOpen: gauge(
			"loom_ledger_reservations_open",
			"Reservations not yet settled.",
		),
		ThrottleRejections: counterVec(
			"loom_throttle_rejections_total",
			"Requests denied as rate_limited; scope=api_key|account, limit=rpm|tpm|concurrency.",
			"scope", "limit",
		),
		MaintenanceRuns: counterVec(
			"loom_maintenance_runs_total",
			"Maintenance task runs; result=ok|skipped (another replica holds the task)|error.",
			"task", "result",
		),
		MaintenanceLastSuccess: gaugeVec(
			"loom_maintenance_last_success_timestamp_seconds",
			"Unix time of the last run that completed or was covered by another replica.",
			"task",
		),
		AuditAggregated: counter(
			"loom_audit_aggregated_requests_total",
			"Unidentified-credential denials folded into aggregated auth_audit rows instead of one row each.",
		),
		IncompleteResponses: counterVec(
			"loom_ledger_incomplete_responses_total",
			"Responses with a 2xx status but no usage (stream cut before its final chunk), settled at the reserve estimate.",
			"model",
		),
		ReserveCompensations: counterVec(
			"loom_ledger_reserve_compensations_total",
			"Releases of reservations whose commit outcome was unknown; result=released|absent|failed.",
			"result",
		),
		ReservationsExpired: counter(
			"loom_ledger_reservations_expired_total",
			"Reservations released because no usage report arrived.",
		),
		CostMismatch: counterVec(
			"loom_ledger_cost_mismatch_total",
			"Settlements whose loom cost differs from the gateway cost.",
			"model",
		),

		// transport
		RateLimitCalls: counterVec(
			"loom_ratelimit_calls_total",
			"RateLimitService calls by phase: check (no charge) or amend (settlement).",
			"phase",
		),
		OTLPQueueDepth: gauge(
			"loom_otlp_queue_depth",
			"OTLP usage reports waiting to be settled.",
		),
		OTLPDropped: counter(
			"loom_otlp_dropped_total",
			"OTLP usage reports dropped because the queue was full.",
		),
		OTLPFlushDuration: histogram(
			"loom_otlp_flush_duration_seconds",
			"OTLP batch settlement latency.",
		),
		OTLPSpans: counter(
			"loom_otlp_spans_total",
			"Trace spans received (counted only).",
		),

		// store
		StoreErrors: counterVec(
			"loom_store_errors_total",
			"PostgreSQL errors by operation.",
			"op",
		),
	}

	buildInfo := gaugeVec(
		"loom_build_info",
		"Build version.",
		"version", "commit",
	)
	buildInfo.WithLabelValues(version, commit).Set(1)

	// 标签取值固定的计数器预先创建 0 值序列：从未出错时告警的 rate() 也有数据可算。
	for _, channel := range []string{"rls", "otlp"} {
		m.SettleErrors.WithLabelValues(channel)
	}
	for _, result := range []string{"ok", "error"} {
		m.PricingReload.WithLabelValues(result)
	}
	for _, scope := range []string{"api_key", "account"} {
		for _, limit := range []string{"rpm", "tpm", "concurrency"} {
			m.ThrottleRejections.WithLabelValues(scope, limit)
		}
	}
	for _, result := range []string{"released", "absent", "failed"} {
		m.ReserveCompensations.WithLabelValues(result)
	}
	for _, kind := range []string{"api_key", "account", "model_price"} {
		for _, origin := range []string{"local", "remote"} {
			m.CacheInvalidations.WithLabelValues(kind, origin)
		}
	}

	m.Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		buildInfo,
		m.AdmissionDecisions,
		m.AdmissionDuration,
		m.CacheLookups,
		m.CacheInvalidations,
		m.CacheSyncReconnects,
		m.PricingLookups,
		m.PricingReload,
		m.PricingModels,
		m.ReservedNanos,
		m.SettledNanos,
		m.Settlements,
		m.SettleErrors,
		m.RemainingNanos,
		m.ReservationsOpen,
		m.ReservationsExpired,
		m.ReserveCompensations,
		m.IncompleteResponses,
		m.ThrottleRejections,
		m.MaintenanceRuns,
		m.MaintenanceLastSuccess,
		m.AuditAggregated,
		m.CostMismatch,
		m.RateLimitCalls,
		m.OTLPQueueDepth,
		m.OTLPDropped,
		m.OTLPFlushDuration,
		m.OTLPSpans,
		m.StoreErrors,
	)
	return m
}

// RegisterPoolStats 以 pgxpool 实时统计注册连接池指标。
func (m *Metrics) RegisterPoolStats(stat func() *pgxpool.Stat) {
	m.Registry.MustRegister(
		gaugeFunc(
			"loom_store_pool_acquired_conns",
			"Connections currently in use.",
			func() float64 { return float64(stat().AcquiredConns()) },
		),
		gaugeFunc(
			"loom_store_pool_idle_conns",
			"Idle connections.",
			func() float64 { return float64(stat().IdleConns()) },
		),
		gaugeFunc(
			"loom_store_pool_max_conns",
			"Maximum pool size.",
			func() float64 { return float64(stat().MaxConns()) },
		),
		counterFunc(
			"loom_store_pool_acquires_total",
			"Successful connection acquisitions.",
			func() float64 { return float64(stat().AcquireCount()) },
		),
		counterFunc(
			"loom_store_pool_empty_acquires_total",
			"Acquisitions that had to wait for a connection.",
			func() float64 { return float64(stat().EmptyAcquireCount()) },
		),
		counterFunc(
			"loom_store_pool_acquire_seconds_total",
			"Total time spent acquiring connections.",
			func() float64 { return stat().AcquireDuration().Seconds() },
		),
	)
}

// 构造 helper：统一「名字、说明、标签」的参数顺序。

func counter(name, help string) prometheus.Counter {
	return prometheus.NewCounter(prometheus.CounterOpts{Name: name, Help: help})
}

func counterVec(name, help string, labels ...string) *prometheus.CounterVec {
	return prometheus.NewCounterVec(prometheus.CounterOpts{Name: name, Help: help}, labels)
}

func gauge(name, help string) prometheus.Gauge {
	return prometheus.NewGauge(prometheus.GaugeOpts{Name: name, Help: help})
}

func gaugeVec(name, help string, labels ...string) *prometheus.GaugeVec {
	return prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: name, Help: help}, labels)
}

func histogram(name, help string) prometheus.Histogram {
	return prometheus.NewHistogram(prometheus.HistogramOpts{Name: name, Help: help})
}

// latencyBuckets 覆盖亚毫秒到秒级：准入在请求关键路径上，需要能分辨 1ms 以内的变化。
var latencyBuckets = []float64{
	0.0005, 0.001, 0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
}

func histogramVec(name, help string, labels ...string) *prometheus.HistogramVec {
	opts := prometheus.HistogramOpts{Name: name, Help: help, Buckets: latencyBuckets}
	return prometheus.NewHistogramVec(opts, labels)
}

func gaugeFunc(name, help string, value func() float64) prometheus.GaugeFunc {
	return prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: name, Help: help}, value)
}

func counterFunc(name, help string, value func() float64) prometheus.CounterFunc {
	return prometheus.NewCounterFunc(prometheus.CounterOpts{Name: name, Help: help}, value)
}
