package ledger

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// Hold 是一次成功预扣的结果。
type Hold struct {
	Nanos int64 // 预扣金额
	// Remaining 两级额度中较小的剩余值；两级都不限额时为 nil。
	Remaining *int64
}

// Reserve 对 Key 与账户做原子预扣，并记录预扣以便结算或过期释放。
// 任一级额度不足返回 ErrInsufficientQuota，且不留下任何冻结。
func (l *Ledger) Reserve(ctx context.Context, key store.Key, card pricing.Card, requestID string) (Hold, error) {
	nanos := card.ReserveNanos
	keyState, err := l.store.ReserveKeyQuota(ctx, key.ID, nanos)
	if err != nil {
		return Hold{}, fmt.Errorf("reserve key quota: %w", err)
	}
	accountState, err := l.store.ReserveAccountQuota(ctx, key.AccountID, nanos)
	if err != nil {
		l.undoKey(ctx, key, nanos)
		return Hold{}, fmt.Errorf("reserve account quota: %w", err)
	}

	if nanos > 0 {
		now := time.Now()
		err := l.store.CreateReservation(ctx, store.Reservation{
			RequestID: requestID,
			KeyID:     key.ID,
			AccountID: key.AccountID,
			Model:     card.Model,
			Nanos:     nanos,
			ExpiresAt: now.Add(l.opts.ReservationTTL),
			CreatedAt: now,
		})
		if err != nil {
			l.undoKey(ctx, key, nanos)
			l.undoAccount(ctx, key, nanos)
			return Hold{}, fmt.Errorf("record reservation: %w", err)
		}
	}

	l.metrics.ReservedNanos.WithLabelValues(card.Model).Add(float64(nanos))
	return Hold{Nanos: nanos, Remaining: minRemaining(keyState, accountState)}, nil
}

// undoKey / undoAccount 在预扣中途失败时撤销已冻结的额度。此时还没有预扣记录，RunReaper 无法兜底，
// 撤销失败只能记录日志、人工核对。
func (l *Ledger) undoKey(ctx context.Context, key store.Key, nanos int64) {
	if err := l.store.ReleaseKeyReservation(ctx, key.ID, nanos); err != nil {
		l.log.Error("undo key reservation failed", "err", err, "key_id", key.ID, "nanos", nanos)
	}
}

func (l *Ledger) undoAccount(ctx context.Context, key store.Key, nanos int64) {
	if err := l.store.ReleaseAccountReservation(ctx, key.AccountID, nanos); err != nil {
		l.log.Error("undo account reservation failed", "err", err, "account_id", key.AccountID, "nanos", nanos)
	}
}

func minRemaining(states ...store.QuotaState) *int64 {
	var result *int64
	for _, s := range states {
		r, bounded := s.Remaining()
		if !bounded {
			continue
		}
		if result == nil || r < *result {
			result = &r
		}
	}
	return result
}

// IsInsufficientQuota 判断错误是否为额度不足。
func IsInsufficientQuota(err error) bool { return errors.Is(err, ErrInsufficientQuota) }
