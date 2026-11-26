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

	// pricing
	PricingLookups *prometheus.CounterVec // {source}
	PricingReload  *prometheus.CounterVec // {result}
	PricingModels  prometheus.Gauge

	// ledger
	ReservedNanos       *prometheus.CounterVec // {model}
	SettledNanos        *prometheus.CounterVec // {model}
	Settlements         *prometheus.CounterVec // {channel, inserted}
	SettleErrors        *prometheus.CounterVec // {channel}
	RemainingNanos      *prometheus.GaugeVec   // {account}
	ReservationsOpen    prometheus.Gauge
	ReservationsExpired prometheus.Counter
	CostMismatch        *prometheus.CounterVec // {model}

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

		AdmissionDecisions: counterVec("loom_admission_decisions_total", "Admission verdicts.", "reason", "allowed"),
		AdmissionDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "loom_admission_duration_seconds",
			Help:    "Admission latency by stage.",
			Buckets: prometheus.DefBuckets,
		}, []string{"stage"}),
		CacheLookups: counterVec("loom_cache_lookups_total", "In-process cache lookups.", "cache", "result"),

		PricingLookups: counterVec("loom_pricing_lookups_total", "Price lookups by source.", "source"),
		PricingReload:  counterVec("loom_pricing_reloads_total", "pricing.yaml reload attempts.", "result"),
		PricingModels:  gauge("loom_pricing_models", "Models defined in pricing.yaml."),

		ReservedNanos: counterVec("loom_ledger_reserved_nanos_total", "Nano-USD reserved at admission.", "model"),
		SettledNanos:  counterVec("loom_ledger_settled_nanos_total", "Nano-USD charged at settlement.", "model"),
		Settlements: counterVec(
			"loom_ledger_settlements_total",
			"Settlement attempts; inserted=false means the request was already settled.",
			"channel",
			"inserted",
		),
		SettleErrors: counterVec("loom_ledger_settle_errors_total", "Settlements that failed.", "channel"),
		RemainingNanos: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{Name: "loom_ledger_remaining_nanos", Help: "Remaining quota of bounded accounts."},
			[]string{"account"},
		),
		ReservationsOpen: gauge("loom_ledger_reservations_open", "Reservations not yet settled."),
		ReservationsExpired: prometheus.NewCounter(
			prometheus.CounterOpts{
				Name: "loom_ledger_reservations_expired_total",
				Help: "Reservations released because no usage report arrived.",
			},
		),
		CostMismatch: counterVec(
			"loom_ledger_cost_mismatch_total",
			"Settlements whose loom cost differs from the gateway cost.",
			"model",
		),

		RateLimitCalls: counterVec(
			"loom_ratelimit_calls_total",
			"RateLimitService calls by phase: check (no charge) or amend (settlement).",
			"phase",
		),
		OTLPQueueDepth: gauge("loom_otlp_queue_depth", "OTLP usage reports waiting to be settled."),
		OTLPDropped: prometheus.NewCounter(
			prometheus.CounterOpts{
				Name: "loom_otlp_dropped_total",
				Help: "OTLP usage reports dropped because the queue was full.",
			},
		),
		OTLPFlushDuration: prometheus.NewHistogram(
			prometheus.HistogramOpts{Name: "loom_otlp_flush_duration_seconds", Help: "OTLP batch settlement latency."},
		),
		OTLPSpans: prometheus.NewCounter(
			prometheus.CounterOpts{Name: "loom_otlp_spans_total", Help: "Trace spans received (counted only)."},
		),

		StoreErrors: counterVec("loom_store_errors_total", "PostgreSQL errors by operation.", "op"),
	}
	buildInfo := prometheus.NewGaugeVec(
		prometheus.GaugeOpts{Name: "loom_build_info", Help: "Build version."},
		[]string{"version", "commit"},
	)
	buildInfo.WithLabelValues(version, commit).Set(1)

	m.Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		buildInfo,
		m.AdmissionDecisions, m.AdmissionDuration, m.CacheLookups,
		m.PricingLookups, m.PricingReload, m.PricingModels,
		m.ReservedNanos, m.SettledNanos, m.Settlements, m.SettleErrors, m.RemainingNanos,
		m.ReservationsOpen, m.ReservationsExpired, m.CostMismatch,
		m.RateLimitCalls, m.OTLPQueueDepth, m.OTLPDropped, m.OTLPFlushDuration, m.OTLPSpans,
		m.StoreErrors,
	)
	return m
}

// RegisterPoolStats 以 pgxpool 实时统计注册连接池指标。
func (m *Metrics) RegisterPoolStats(stat func() *pgxpool.Stat) {
	gaugeFunc := func(name, help string, value func(*pgxpool.Stat) float64) prometheus.Collector {
		return prometheus.NewGaugeFunc(
			prometheus.GaugeOpts{Name: name, Help: help},
			func() float64 { return value(stat()) },
		)
	}
	counterFunc := func(name, help string, value func(*pgxpool.Stat) float64) prometheus.Collector {
		return prometheus.NewCounterFunc(
			prometheus.CounterOpts{Name: name, Help: help},
			func() float64 { return value(stat()) },
		)
	}
	m.Registry.MustRegister(
		gaugeFunc("loom_store_pool_acquired_conns", "Connections currently in use.",
			func(s *pgxpool.Stat) float64 { return float64(s.AcquiredConns()) }),
		gaugeFunc("loom_store_pool_idle_conns", "Idle connections.",
			func(s *pgxpool.Stat) float64 { return float64(s.IdleConns()) }),
		gaugeFunc("loom_store_pool_max_conns", "Maximum pool size.",
			func(s *pgxpool.Stat) float64 { return float64(s.MaxConns()) }),
		counterFunc("loom_store_pool_acquires_total", "Successful connection acquisitions.",
			func(s *pgxpool.Stat) float64 { return float64(s.AcquireCount()) }),
		counterFunc("loom_store_pool_empty_acquires_total", "Acquisitions that had to wait for a connection.",
			func(s *pgxpool.Stat) float64 { return float64(s.EmptyAcquireCount()) }),
		counterFunc("loom_store_pool_acquire_seconds_total", "Total time spent acquiring connections.",
			func(s *pgxpool.Stat) float64 { return s.AcquireDuration().Seconds() }),
	)
}

func counterVec(name, help string, labels ...string) *prometheus.CounterVec {
	return prometheus.NewCounterVec(prometheus.CounterOpts{Name: name, Help: help}, labels)
}

func gauge(name, help string) prometheus.Gauge {
	return prometheus.NewGauge(prometheus.GaugeOpts{Name: name, Help: help})
}
