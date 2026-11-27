package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// 数据增长：按月分区、日汇总与保留期清理。分区的建与删由迁移 0006 中的 PL/pgSQL 函数完成。

// partitionedTables 按月分区（RANGE (time)）的表。
var partitionedTables = []string{"usage_events", "auth_audit"}

// EnsurePartitions 见 store.Store。
func (d *DB) EnsurePartitions(ctx context.Context, from, to time.Time) (created int, err error) {
	err = d.maintain(ctx, "partitions", func(q *sqlcgen.Queries) error {
		for _, table := range partitionedTables {
			n, err := q.EnsureMonthPartitions(ctx, sqlcgen.EnsureMonthPartitionsParams{
				Parent:     table,
				FirstMonth: from,
				LastMonth:  to,
			})
			if err != nil {
				return d.fail("EnsurePartitions", err)
			}
			created += int(n)
		}
		return nil
	})
	return created, err
}

// RollupUsageDaily 见 store.Store：重算与推进水位线在同一事务内，SummaryUsage 看到的两部分始终首尾相接。
func (d *DB) RollupUsageDaily(ctx context.Context, from, to time.Time) error {
	return d.maintain(ctx, "rollup", func(q *sqlcgen.Queries) error {
		if err := q.RollupUsageDaily(ctx, sqlcgen.RollupUsageDailyParams{FromTime: from, ToTime: to}); err != nil {
			return d.fail("RollupUsageDaily", err)
		}
		return d.fail("RollupUsageDaily.advance", q.AdvanceUsageRollup(ctx, to))
	})
}

// UsageRollupWatermark 见 store.Store。
func (d *DB) UsageRollupWatermark(ctx context.Context) (time.Time, bool, error) {
	through, err := d.q.GetUsageRollup(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, d.fail("UsageRollupWatermark", err)
	}
	return through, true, nil
}

// PruneUsageEvents 见 store.Store：删除整月都早于 before 的分区，返回分区数。
func (d *DB) PruneUsageEvents(ctx context.Context, before time.Time) (int64, error) {
	return d.dropPartitions(ctx, "usage_events", before)
}

// PruneAudit 见 store.Store。
func (d *DB) PruneAudit(ctx context.Context, before time.Time) (int64, error) {
	return d.dropPartitions(ctx, "auth_audit", before)
}

func (d *DB) dropPartitions(ctx context.Context, table string, before time.Time) (dropped int64, err error) {
	err = d.maintain(ctx, "partitions", func(q *sqlcgen.Queries) error {
		n, err := q.DropMonthPartitions(ctx, sqlcgen.DropMonthPartitionsParams{Parent: table, Before: before})
		dropped = int64(n)
		return d.fail("Prune."+table, err)
	})
	return dropped, err
}

// PruneSettledRequests 见 store.Store，返回删除的行数。
func (d *DB) PruneSettledRequests(ctx context.Context, before time.Time) (int64, error) {
	n, err := d.q.DeleteSettledRequests(ctx, before)
	return n, d.fail("PruneSettledRequests", err)
}

// maintain 在持有该任务 advisory lock 的事务中执行 fn；其他副本正在执行时返回 store.ErrMaintenanceBusy。
func (d *DB) maintain(ctx context.Context, task string, fn func(q *sqlcgen.Queries) error) error {
	return d.inTx(ctx, "maintenance."+task, func(q *sqlcgen.Queries) error {
		locked, err := q.TryMaintenanceLock(ctx, task)
		if err != nil {
			return d.fail("maintenance.lock", err)
		}
		if !locked {
			return store.ErrMaintenanceBusy
		}
		return fn(q)
	})
}
