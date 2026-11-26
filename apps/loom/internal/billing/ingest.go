// Package billing 接收网关 OTLP access log，按 loom 计价表算钱并以幂等方式结算到两级额度。
package billing

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// Record 从一条 access log 中抽出的字段。
type Record struct {
	Time             time.Time
	RequestID        string
	TraceID          string
	SpanID           string
	ClientID         string
	KeyID            uuid.UUID
	Model            string
	Provider         string
	Route            string
	Gateway          string
	Protocol         string
	InputTokens      int64
	OutputTokens     int64
	CachedTokens     int64
	GatewayCostNanos *int64
	// PricingSource 由 ingest 回填，仅用于指标。
	PricingSource string
}

// attrs 把 OTLP KeyValue 列表转为 map。
func attrs(kvs []*commonpb.KeyValue) map[string]any {
	m := make(map[string]any, len(kvs))
	for _, kv := range kvs {
		if kv == nil || kv.Value == nil {
			continue
		}
		switch v := kv.Value.Value.(type) {
		case *commonpb.AnyValue_StringValue:
			m[kv.Key] = v.StringValue
		case *commonpb.AnyValue_IntValue:
			m[kv.Key] = v.IntValue
		case *commonpb.AnyValue_DoubleValue:
			m[kv.Key] = v.DoubleValue
		case *commonpb.AnyValue_BoolValue:
			m[kv.Key] = v.BoolValue
		}
	}
	return m
}

func str(m map[string]any, k string) string {
	if v, ok := m[k]; ok {
		switch t := v.(type) {
		case string:
			return t
		case int64:
			return fmt.Sprintf("%d", t)
		case float64:
			return fmt.Sprintf("%v", t)
		}
	}
	return ""
}

func i64(m map[string]any, k string) int64 {
	if v, ok := m[k]; ok {
		switch t := v.(type) {
		case int64:
			return t
		case float64:
			return int64(t)
		case string:
			var n int64
			_, _ = fmt.Sscanf(t, "%d", &n)
			return n
		}
	}
	return 0
}

func f64(m map[string]any, k string) (float64, bool) {
	if v, ok := m[k]; ok {
		switch t := v.(type) {
		case float64:
			return t, true
		case int64:
			return float64(t), true
		case string:
			var f float64
			_, err := fmt.Sscanf(t, "%g", &f)
			return f, err == nil
		}
	}
	return 0, false
}

// RecordFromLogRecord 按 attributes 映射把 OTLP LogRecord 转为 Record。
func RecordFromLogRecord(lr *logspb.LogRecord, res []*commonpb.KeyValue, am config.AttributeMap) Record {
	// 资源属性 + 记录属性合并，记录属性优先
	m := attrs(res)
	for k, v := range attrs(lr.GetAttributes()) {
		m[k] = v
	}
	r := Record{
		RequestID:    str(m, am.RequestID),
		ClientID:     str(m, am.ClientID),
		Model:        str(m, am.Model),
		Provider:     str(m, am.Provider),
		Route:        str(m, am.Route),
		Gateway:      str(m, am.Gateway),
		Protocol:     str(m, "protocol"),
		InputTokens:  i64(m, am.InputTokens),
		OutputTokens: i64(m, am.OutputTokens),
		CachedTokens: i64(m, am.CachedTokens),
	}
	// 非 LLM 协议（如图片路由）没有 gen_ai.request.model，改用 extAuth 注入的 loom.model
	if r.Model == "" {
		r.Model = str(m, "loom.model")
	}
	if id := str(m, am.KeyID); id != "" {
		if u, err := uuid.Parse(id); err == nil {
			r.KeyID = u
		}
	}
	if v, ok := f64(m, am.GatewayCost); ok {
		n := int64(v*float64(loom.NanoUSDPerUSD) + 0.5)
		r.GatewayCostNanos = &n
	}
	ts := lr.GetTimeUnixNano()
	if ts == 0 {
		ts = lr.GetObservedTimeUnixNano()
	}
	if ts > 0 {
		r.Time = time.Unix(0, int64(ts))
	}
	if len(lr.GetTraceId()) == 16 {
		r.TraceID = hex.EncodeToString(lr.GetTraceId())
	}
	if len(lr.GetSpanId()) == 8 {
		r.SpanID = hex.EncodeToString(lr.GetSpanId())
	}
	return r
}

// Ingest 批量入库器。
type Ingest struct {
	cfg     config.Billing
	st      store.Store
	pricing *pricing.Service
	m       *telemetry.Metrics
	log     *slog.Logger
	ch      chan Record
	resolve *Resolver
}

// NewIngest 创建入库器。
func NewIngest(cfg config.Billing, st store.Store, pr *pricing.Service, m *telemetry.Metrics, log *slog.Logger, resolve *Resolver) *Ingest {
	size := cfg.QueueSize
	if size <= 0 {
		size = 4096
	}
	return &Ingest{cfg: cfg, st: st, pricing: pr, m: m, log: log, ch: make(chan Record, size), resolve: resolve}
}

// Queue 入队；队列满时丢弃并计数。
func (i *Ingest) Queue(r Record) bool {
	if len(i.cfg.Protocols) > 0 {
		ok := false
		for _, p := range i.cfg.Protocols {
			if p == r.Protocol {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if r.Model == "" {
		return false
	}
	select {
	case i.ch <- r:
		if i.m != nil {
			i.m.IngestQueueDepth.Set(float64(len(i.ch)))
		}
		return true
	default:
		if i.m != nil {
			i.m.IngestDropped.Inc()
		}
		i.log.Warn("ingest queue full, dropping record", "request_id", r.RequestID, "model", r.Model)
		return false
	}
}

// Start 启动批处理 worker，阻塞直到 ctx 结束并刷盘。
func (i *Ingest) Start(ctx context.Context) {
	interval := i.cfg.FlushInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	batch := i.cfg.BatchSize
	if batch <= 0 {
		batch = 200
	}
	buf := make([]Record, 0, batch)
	t := time.NewTicker(interval)
	defer t.Stop()
	flush := func() {
		if len(buf) == 0 {
			return
		}
		start := time.Now()
		for _, r := range buf {
			i.process(ctx, r)
		}
		if i.m != nil {
			i.m.IngestFlushDuration.Observe(time.Since(start).Seconds())
		}
		buf = buf[:0]
	}
	for {
		select {
		case <-ctx.Done():
			for {
				select {
				case r := <-i.ch:
					buf = append(buf, r)
					continue
				default:
				}
				break
			}
			flush()
			return
		case r := <-i.ch:
			buf = append(buf, r)
			if len(buf) >= batch {
				flush()
			}
		case <-t.C:
			flush()
		}
	}
}

// process 单条记录：解析归属 → 定价 → 结算。带 3 次重试。
func (i *Ingest) process(ctx context.Context, r Record) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		inserted, err := i.settle(ctx, r)
		if err == nil {
			if i.m != nil {
				i.m.UsageIngested.WithLabelValues(r.PricingSource, fmt.Sprintf("%t", inserted)).Inc()
			}
			return
		}
		lastErr = err
		if errors.Is(err, loom.ErrNotFound) {
			break
		}
		time.Sleep(time.Duration(attempt+1) * 200 * time.Millisecond)
	}
	if i.m != nil {
		i.m.IngestErrors.WithLabelValues("settle").Inc()
	}
	i.log.Error("usage settle failed", "err", lastErr, "request_id", r.RequestID, "model", r.Model)
}

func (i *Ingest) settle(ctx context.Context, r Record) (bool, error) {
	owner, err := i.resolve.Resolve(ctx, r)
	if err != nil {
		return false, err
	}
	if r.Time.IsZero() {
		r.Time = time.Now()
	}
	var cost int64
	source := ""
	card, err := i.pricing.Lookup(ctx, r.Model, owner.Group)
	if err == nil {
		cost = card.Cost(r.InputTokens, r.OutputTokens, r.CachedTokens)
		source = card.Source
	} else if !errors.Is(err, pricing.ErrNotPriced) {
		return false, err
	}
	if i.cfg.CostSource == "gateway_prefer" && r.GatewayCostNanos != nil {
		cost = *r.GatewayCostNanos
		source = "gateway"
	}
	// 对账：loom 自己算出金额且网关也上报了金额，两者相差超过 1 nano 即视为不一致。
	// 网关 catalog 不表达分组倍率，非 default 倍率（GroupRatio != 1）的账户跳过比较。
	if source != "" && source != "gateway" && r.GatewayCostNanos != nil && i.m != nil && card.GroupRatio == 1 {
		if diff := *r.GatewayCostNanos - cost; diff > 1 || diff < -1 {
			i.m.CostMismatch.WithLabelValues(r.Model).Inc()
			i.log.Warn("cost mismatch between loom and gateway", "request_id", r.RequestID, "model", r.Model,
				"loom_nanos", cost, "gateway_nanos", *r.GatewayCostNanos)
		}
	}
	ev := store.UsageEvent{Time: r.Time, RequestID: r.RequestID, TraceID: r.TraceID, SpanID: r.SpanID, Model: r.Model,
		Provider: r.Provider, Route: r.Route, Gateway: r.Gateway, InputTokens: r.InputTokens, OutputTokens: r.OutputTokens,
		CachedTokens: r.CachedTokens, CostNanos: cost, GatewayCostNanos: r.GatewayCostNanos, PricingSource: source}
	if owner.KeyID != uuid.Nil {
		id := owner.KeyID
		ev.KeyID = &id
	}
	if owner.AccountID != uuid.Nil {
		id := owner.AccountID
		ev.AccountID = &id
	}
	inserted, err := i.st.SettleUsage(ctx, ev)
	if err != nil {
		return false, err
	}
	if inserted && i.m != nil {
		i.m.QuotaSettled.WithLabelValues(r.Model).Add(float64(cost))
	}
	r.PricingSource = source
	return inserted, nil
}

// Owner 归属信息。
type Owner struct {
	AccountID uuid.UUID
	KeyID     uuid.UUID
	Group     string
}
