package ledger

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// ReservationHold 是一次成功预扣的结果。
type ReservationHold struct {
	Nanos int64 // 预扣金额
	// Remaining 两级额度中较小的剩余值；两级都不限额时为 nil。
	Remaining *int64
}

// ReserveQuota 对 Key 与账户做原子预扣，并记录预扣以便结算或过期释放。
// 任一级额度不足返回 ErrInsufficientQuota，且不留下任何冻结。
func (l *Ledger) ReserveQuota(
	ctx context.Context,
	apiKey store.APIKey,
	unitPrice pricing.UnitPrice,
	requestID string,
) (ReservationHold, error) {
	nanos := unitPrice.ReserveNanos
	keyState, err := l.store.ReserveAPIKeyQuota(ctx, apiKey.ID, nanos)
	if err != nil {
		return ReservationHold{}, fmt.Errorf("reserve apiKey quota: %w", err)
	}
	accountState, err := l.store.ReserveAccountQuota(ctx, apiKey.AccountID, nanos)
	if err != nil {
		l.undoAPIKeyReservation(ctx, apiKey, nanos)
		return ReservationHold{}, fmt.Errorf("reserve account quota: %w", err)
	}

	if nanos > 0 {
		now := time.Now()
		err := l.store.CreateReservation(ctx, store.Reservation{
			RequestID: requestID,
			APIKeyID:  apiKey.ID,
			AccountID: apiKey.AccountID,
			Model:     unitPrice.Model,
			Nanos:     nanos,
			ExpiresAt: now.Add(l.opts.ReservationTTL),
			CreatedAt: now,
		})
		if err != nil {
			l.undoAPIKeyReservation(ctx, apiKey, nanos)
			l.undoAccountReservation(ctx, apiKey, nanos)
			return ReservationHold{}, fmt.Errorf("record reservation: %w", err)
		}
	}

	l.metrics.ReservedNanos.WithLabelValues(unitPrice.Model).Add(float64(nanos))
	return ReservationHold{Nanos: nanos, Remaining: minRemaining(keyState, accountState)}, nil
}

// undoAPIKeyReservation / undoAccountReservation 在预扣中途失败时撤销已冻结的额度。此时还没有预扣记录，RunReaper 无法兜底，
// 撤销失败只能记录日志、人工核对。
func (l *Ledger) undoAPIKeyReservation(ctx context.Context, apiKey store.APIKey, nanos int64) {
	if err := l.store.ReleaseAPIKeyReservation(ctx, apiKey.ID, nanos); err != nil {
		l.log.Error(
			"undo apiKey reservation failed",
			"err", err,
			"key_id", apiKey.ID,
			"nanos", nanos,
		)
	}
}

func (l *Ledger) undoAccountReservation(ctx context.Context, apiKey store.APIKey, nanos int64) {
	if err := l.store.ReleaseAccountReservation(ctx, apiKey.AccountID, nanos); err != nil {
		l.log.Error(
			"undo account reservation failed",
			"err", err,
			"account_id", apiKey.AccountID,
			"nanos", nanos,
		)
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
