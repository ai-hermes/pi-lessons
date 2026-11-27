// Package maintenance 定期维护数据增长：建好未来几个月的分区、把明细汇总进日汇总表、按保留期清理过期数据。
//
// 每一轮按固定顺序执行，且明细只会在汇总之后、并且只删除已汇总过的部分，保证 usage_daily 永远覆盖被删掉的明细。
// 多副本同时运行时，由存储层的锁保证同一任务同一时刻只有一个副本在执行，其余副本记为 skipped。
package maintenance

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

const day = 24 * time.Hour

// 任务名；也是指标标签 task 的取值。
const (
	TaskPartitions      = "partitions"
	TaskRollup          = "rollup"
	TaskPruneUsage      = "prune_usage_events"
	TaskPruneAudit      = "prune_auth_audit"
	TaskPruneIdempotent = "prune_settled_requests"
)

// Tasks 全部任务，按执行顺序排列。
var Tasks = []string{TaskPartitions, TaskRollup, TaskPruneUsage, TaskPruneAudit, TaskPruneIdempotent}

// Store 是维护任务所需的持久化能力。
type Store interface {
	EnsurePartitions(ctx context.Context, from, to time.Time) (int, error)
	RollupUsageDaily(ctx context.Context, from, to time.Time) error
	UsageRollupWatermark(ctx context.Context) (time.Time, bool, error)
	PruneUsageEvents(ctx context.Context, before time.Time) (int64, error)
	PruneAudit(ctx context.Context, before time.Time) (int64, error)
	PruneSettledRequests(ctx context.Context, before time.Time) (int64, error)
}

// Options 维护参数。
type Options struct {
	Interval              time.Duration // 两轮维护的间隔
	PartitionsAheadMonths int           // 提前建好的月份分区数
	UsageEventsRetention  time.Duration // usage_events 明细保留期
	AuditRetention        time.Duration // auth_audit 保留期
	IdempotencyRetention  time.Duration // settled_requests 保留期，须大于 OTLP 补账的最大延迟
}

// Runner 维护任务执行器。
type Runner struct {
	opts    Options
	store   Store
	metrics *telemetry.Metrics
	log     *slog.Logger
	now     func() time.Time
}

// New 创建维护任务执行器。
func New(opts Options, storage Store, metrics *telemetry.Metrics, log *slog.Logger) *Runner {
	// 预建 0 值序列：从未成功时“距上次成功”的告警也有数据可算
	for _, task := range Tasks {
		metrics.MaintenanceLastSuccess.WithLabelValues(task)
		for _, result := range []string{"ok", "skipped", "error"} {
			metrics.MaintenanceRuns.WithLabelValues(task, result)
		}
	}
	return &Runner{
		opts:    opts,
		store:   storage,
		metrics: metrics,
		log:     log,
		now:     time.Now,
	}
}

// Run 启动后立即执行一轮，之后每 Interval 执行一轮，阻塞直到 ctx 结束。
func (r *Runner) Run(ctx context.Context) {
	r.RunOnce(ctx)
	ticker := time.NewTicker(r.opts.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.RunOnce(ctx)
		}
	}
}

// Report 一轮维护中各任务的结果：ok、skipped（另一副本正在执行）或 error。
type Report map[string]string

// RunOnce 按顺序执行一轮全部任务；某个任务失败不影响后续任务，但汇总失败时不清理明细。
func (r *Runner) RunOnce(ctx context.Context) Report {
	now := r.now().UTC()
	idempotencyCutoff := now.Add(-r.opts.IdempotencyRetention)
	return Report{
		TaskPartitions: r.record(TaskPartitions, r.ensurePartitions(ctx, now)),
		TaskRollup:     r.record(TaskRollup, r.rollup(ctx, now)),
		TaskPruneUsage: r.record(TaskPruneUsage, r.pruneUsage(ctx, now)),
		TaskPruneAudit: r.record(
			TaskPruneAudit,
			r.prune(ctx, TaskPruneAudit, r.store.PruneAudit, now.Add(-r.opts.AuditRetention)),
		),
		TaskPruneIdempotent: r.record(
			TaskPruneIdempotent,
			r.prune(ctx, TaskPruneIdempotent, r.store.PruneSettledRequests, idempotencyCutoff),
		),
	}
}

func (r *Runner) ensurePartitions(ctx context.Context, now time.Time) error {
	created, err := r.store.EnsurePartitions(ctx, now, now.AddDate(0, r.opts.PartitionsAheadMonths, 0))
	if created > 0 {
		r.log.Info("created monthly partitions", "count", created)
	}
	return err
}

// rollup 重算从水位线前一天（吸收迟到的结算与网关金额补写）到今天零点的日汇总。
// 从未汇总过时覆盖全部历史明细：日汇总永久保留，不能让早于明细保留期的数据没汇总就被清理。
func (r *Runner) rollup(ctx context.Context, now time.Time) error {
	today := now.Truncate(day)
	from := time.Unix(0, 0).UTC()
	through, ok, err := r.store.UsageRollupWatermark(ctx)
	if err != nil {
		return err
	}
	if ok {
		from = through.Add(-day)
	}
	return r.store.RollupUsageDaily(ctx, from, today)
}

// pruneUsage 删除超过保留期、且已经汇总过的明细。
func (r *Runner) pruneUsage(ctx context.Context, now time.Time) error {
	through, ok, err := r.store.UsageRollupWatermark(ctx)
	if err != nil {
		return err
	}
	if !ok {
		return nil // 还没汇总过，明细一行也不删
	}
	before := now.Add(-r.opts.UsageEventsRetention)
	if through.Before(before) {
		before = through
	}
	return r.prune(ctx, TaskPruneUsage, r.store.PruneUsageEvents, before)
}

func (r *Runner) prune(
	ctx context.Context,
	task string,
	prune func(context.Context, time.Time) (int64, error),
	before time.Time,
) error {
	removed, err := prune(ctx, before)
	if removed > 0 {
		r.log.Info("pruned expired data", "task", task, "removed", removed, "before", before)
	}
	return err
}

// record 记录任务结果：另一副本正在执行记为 skipped，也算按时完成。
func (r *Runner) record(task string, err error) string {
	result := "ok"
	switch {
	case errors.Is(err, store.ErrMaintenanceBusy):
		result = "skipped"
	case err != nil:
		result = "error"
		r.log.Error("maintenance task failed", "task", task, "err", err)
	}
	r.metrics.MaintenanceRuns.WithLabelValues(task, result).Inc()
	if result != "error" {
		r.metrics.MaintenanceLastSuccess.WithLabelValues(task).Set(float64(r.now().Unix()))
	}
	return result
}
