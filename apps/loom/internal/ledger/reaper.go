package ledger

import (
	"context"
	"time"
)

const accountGaugeLimit = 1000

// RunReaper 周期释放过期预扣，阻塞直到 ctx 结束。
// 预扣过期意味着两条用量上报通道（RLS、OTLP）都没送达，释放后该请求不计费，
// 所以 loom_ledger_reservations_expired_total 增长是需要排查的信号。
func (l *Ledger) RunReaper(ctx context.Context) {
	ticker := time.NewTicker(l.opts.ReaperInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			l.releaseExpired(ctx)
		}
	}
}

func (l *Ledger) releaseExpired(ctx context.Context) {
	n, err := l.store.ReleaseExpiredReservations(ctx, time.Now(), l.opts.ReaperBatch)
	if err != nil {
		l.log.Warn("release expired reservations failed", "err", err)
		return
	}
	if n == 0 {
		return
	}
	l.metrics.ReservationsExpired.Add(float64(n))
	l.log.Warn("released expired reservations without usage report", "count", n)
}

// RefreshGauges 刷新预扣存量与有上限账户的剩余额度指标。
func (l *Ledger) RefreshGauges(ctx context.Context) {
	if n, err := l.store.CountReservations(ctx); err == nil {
		l.metrics.ReservationsOpen.Set(float64(n))
	}
	accounts, err := l.store.ListAccounts(ctx, accountGaugeLimit)
	if err != nil {
		return
	}
	for _, a := range accounts {
		if remaining, bounded := a.Remaining(); bounded {
			l.metrics.RemainingNanos.WithLabelValues(a.Name).Set(float64(remaining))
		}
	}
}
