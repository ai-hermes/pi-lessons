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

// ReserveQuota 对 API Key 与账户做原子预扣并记录预扣，以便结算或过期释放。
// 两级预扣与预扣记录在同一个事务中完成：任一级额度不足返回 ErrInsufficientQuota，
// context 被取消（例如准入超时）时整体回滚，都不会留下冻结。
func (l *Ledger) ReserveQuota(
	ctx context.Context,
	apiKey store.APIKey,
	unitPrice pricing.UnitPrice,
	requestID string,
) (ReservationHold, error) {
	nanos := unitPrice.ReserveNanos
	if nanos <= 0 {
		// 免费请求不预扣，只读出两级额度用于返回剩余额度
		keyState, err := l.store.ReserveAPIKeyQuota(ctx, apiKey.ID, 0)
		if err != nil {
			return ReservationHold{}, fmt.Errorf("read api key quota: %w", err)
		}
		accountState, err := l.store.ReserveAccountQuota(ctx, apiKey.AccountID, 0)
		if err != nil {
			return ReservationHold{}, fmt.Errorf("read account quota: %w", err)
		}
		return ReservationHold{Remaining: minRemaining(keyState, accountState)}, nil
	}

	now := time.Now()
	reserved, err := l.store.ReserveQuota(ctx, store.Reservation{
		RequestID: requestID,
		APIKeyID:  apiKey.ID,
		AccountID: apiKey.AccountID,
		Model:     unitPrice.Model,
		Nanos:     nanos,
		ExpiresAt: now.Add(l.opts.ReservationTTL),
		CreatedAt: now,
	})
	if err != nil {
		return ReservationHold{}, fmt.Errorf("reserve quota: %w", err)
	}
	l.metrics.ReservedNanos.WithLabelValues(unitPrice.Model).Add(float64(nanos))
	return ReservationHold{Nanos: nanos, Remaining: minRemaining(reserved.APIKey, reserved.Account)}, nil
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
