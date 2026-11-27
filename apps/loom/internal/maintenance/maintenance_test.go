package maintenance

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/memstore"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

var ctx = context.Background()

func options() Options {
	return Options{
		Interval:              time.Minute,
		PartitionsAheadMonths: 3,
		UsageEventsRetention:  180 * day,
		AuditRetention:        90 * day,
		IdempotencyRetention:  7 * day,
	}
}

func newRunner(st Store, now time.Time) (*Runner, *telemetry.Metrics) {
	metrics := telemetry.NewMetrics("test", "test")
	r := New(options(), st, metrics, slog.New(slog.DiscardHandler))
	r.now = func() time.Time { return now }
	return r, metrics
}

func TestRunOnceRollsUpBeforePruning(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	st := memstore.New()
	keyID, accountID := uuid.New(), uuid.New()
	for i, age := range []time.Duration{400 * day, 2 * day, time.Hour} {
		_, err := st.SettleUsage(ctx, store.UsageEvent{
			Time:      now.Add(-age),
			RequestID: uuid.NewString(),
			APIKeyID:  &keyID,
			AccountID: &accountID,
			Model:     "m",
			CostNanos: int64(100 * (i + 1)),
		})
		require.NoError(t, err)
	}
	r, metrics := newRunner(st, now)

	r.RunOnce(ctx)

	events, err := st.ListUsage(ctx, &keyID, nil, 10)
	require.NoError(t, err)
	assert.Len(t, events, 2, "details older than the retention are pruned")
	rows, err := st.SummaryUsage(ctx, store.UsageFilter{APIKeyID: &keyID})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, int64(600), rows[0].CostNanos, "the first rollup covers history older than the retention too")
	through, ok, err := st.UsageRollupWatermark(ctx)
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, now.Truncate(day), through)
	for _, task := range Tasks {
		assert.InDelta(t, 1, testutil.ToFloat64(metrics.MaintenanceRuns.WithLabelValues(task, "ok")), 0, task)
	}
}

// failingRollup 汇总失败：明细不能被清理。
type failingRollup struct{ *memstore.Store }

func (failingRollup) RollupUsageDaily(context.Context, time.Time, time.Time) error {
	return errors.New("rollup failed")
}

func TestNoPruningBeforeTheFirstRollup(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	st := memstore.New()
	_, err := st.SettleUsage(ctx, store.UsageEvent{Time: now.Add(-400 * day), RequestID: "old", Model: "m"})
	require.NoError(t, err)
	r, metrics := newRunner(failingRollup{st}, now)

	r.RunOnce(ctx)

	events, err := st.ListUsage(ctx, nil, nil, 10)
	require.NoError(t, err)
	assert.Len(t, events, 1, "nothing has been rolled up, so nothing is deleted")
	assert.InDelta(t, 1, testutil.ToFloat64(metrics.MaintenanceRuns.WithLabelValues(TaskRollup, "error")), 0)
}

// busyStore 另一个副本正在执行全部任务。
type busyStore struct{ *memstore.Store }

func (busyStore) EnsurePartitions(context.Context, time.Time, time.Time) (int, error) {
	return 0, store.ErrMaintenanceBusy
}

func TestBusyTaskCountsAsCovered(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	r, metrics := newRunner(busyStore{memstore.New()}, now)

	r.RunOnce(ctx)

	assert.InDelta(t, 1, testutil.ToFloat64(metrics.MaintenanceRuns.WithLabelValues(TaskPartitions, "skipped")), 0)
	lastSuccess := testutil.ToFloat64(metrics.MaintenanceLastSuccess.WithLabelValues(TaskPartitions))
	assert.InDelta(t, float64(now.Unix()), lastSuccess, 0)
}
