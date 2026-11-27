package otlp

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"time"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/ledger"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

const settleAttempts = 3

// Settler 结算用量。
type Settler interface {
	Settle(ctx context.Context, report ledger.UsageReport) (bool, error)
}

// QueueOptions 补账队列参数。
type QueueOptions struct {
	Protocols     []string // 只结算这些协议的 access log；空表示不过滤
	Size          int
	BatchSize     int
	FlushInterval time.Duration
}

// Queue 缓冲 access log 中的用量并批量结算；满了即丢弃，绝不阻塞网关的 Export。
type Queue struct {
	opts    QueueOptions
	items   chan ledger.UsageReport
	settler Settler
	metrics *telemetry.Metrics
	log     *slog.Logger
}

// NewQueue 创建补账队列；需调用 Run 才会消费。
func NewQueue(opts QueueOptions, settler Settler, metrics *telemetry.Metrics, log *slog.Logger) *Queue {
	if opts.Size <= 0 {
		opts.Size = 4096
	}
	if opts.BatchSize <= 0 {
		opts.BatchSize = 200
	}
	if opts.FlushInterval <= 0 {
		opts.FlushInterval = 2 * time.Second
	}
	return &Queue{
		opts:    opts,
		items:   make(chan ledger.UsageReport, opts.Size),
		settler: settler,
		metrics: metrics,
		log:     log,
	}
}

func (q *Queue) enqueue(report ledger.UsageReport, protocol string) {
	if report.Model == "" {
		return // 健康检查等非计费流量
	}
	if len(q.opts.Protocols) > 0 && !slices.Contains(q.opts.Protocols, protocol) {
		return
	}
	select {
	case q.items <- report:
		q.metrics.OTLPQueueDepth.Set(float64(len(q.items)))
	default:
		q.metrics.OTLPDropped.Inc()
		q.log.Warn("otlp queue full, dropping usage report", "request_id", report.RequestID, "model", report.Model)
	}
}

// Run 按批量或间隔结算，阻塞直到 ctx 结束并处理完队列中已有的记录。
func (q *Queue) Run(ctx context.Context) {
	ticker := time.NewTicker(q.opts.FlushInterval)
	defer ticker.Stop()
	batch := make([]ledger.UsageReport, 0, q.opts.BatchSize)
	flush := func(ctx context.Context) {
		if len(batch) == 0 {
			return
		}
		start := time.Now()
		for _, report := range batch {
			q.settle(ctx, report)
		}
		q.metrics.OTLPFlushDuration.Observe(time.Since(start).Seconds())
		q.metrics.OTLPQueueDepth.Set(float64(len(q.items)))
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			batch = append(batch, q.drain()...)
			flush(context.WithoutCancel(ctx))
			return
		case report := <-q.items:
			batch = append(batch, report)
			if len(batch) >= q.opts.BatchSize {
				flush(ctx)
			}
		case <-ticker.C:
			flush(ctx)
		}
	}
}

func (q *Queue) drain() []ledger.UsageReport {
	var rest []ledger.UsageReport
	for {
		select {
		case report := <-q.items:
			rest = append(rest, report)
		default:
			return rest
		}
	}
}

// settle 结算一条记录，瞬时错误重试；归属不存在不重试。
func (q *Queue) settle(ctx context.Context, report ledger.UsageReport) {
	var err error
	for attempt := range settleAttempts {
		if _, err = q.settler.Settle(ctx, report); err == nil || errors.Is(err, store.ErrNotFound) {
			break
		}
		time.Sleep(time.Duration(attempt+1) * 200 * time.Millisecond)
	}
	if err != nil {
		q.log.Error(
			"otlp settlement failed",
			"err", err,
			"request_id", report.RequestID,
			"model", report.Model,
		)
	}
}
