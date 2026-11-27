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

// ReserveRequest 一次预扣的输入。
type ReserveRequest struct {
	APIKey      store.APIKey
	UnitPrice   pricing.UnitPrice
	RequestID   string
	Concurrency store.ConcurrencyLimits // 两级并发上限；nil 表示不限
}

// ReserveQuota 对 API Key 与账户做原子预扣并记录预扣，以便结算或过期释放。免费请求（预扣额为 0）也写预扣记录，
// 以占用并发名额。两级额度、并发与预扣记录在同一个事务中完成：额度不足返回 ErrInsufficientQuota，
// 并发已满返回 *store.RateLimitError；context 被取消（例如准入超时）时整体回滚，都不会留下冻结。
func (l *Ledger) ReserveQuota(ctx context.Context, req ReserveRequest) (ReservationHold, error) {
	unitPrice := req.UnitPrice
	nanos := max(unitPrice.ReserveNanos, 0)
	now := time.Now()
	reserved, err := l.store.ReserveQuota(ctx, store.Reservation{
		RequestID: req.RequestID,
		APIKeyID:  req.APIKey.ID,
		AccountID: req.APIKey.AccountID,
		Model:     unitPrice.Model,
		Nanos:     nanos,
		ExpiresAt: now.Add(l.opts.ReservationTTL),
		CreatedAt: now,
	}, req.Concurrency)
	if err != nil {
		if errors.Is(err, store.ErrCommitOutcomeUnknown) {
			go l.compensateReservation(ctx, req.RequestID)
		}
		return ReservationHold{}, fmt.Errorf("reserve quota: %w", err)
	}
	l.metrics.ReservedNanos.WithLabelValues(unitPrice.Model).Add(float64(nanos))
	return ReservationHold{Nanos: nanos, Remaining: minRemaining(reserved.APIKey, reserved.Account)}, nil
}

// 补偿释放的总时限与重试间隔。确认丢失多半伴随主库故障，CloudNativePG 强制故障切换约需 17s（主库租约 15s），
// 时限要覆盖它；仍失败时由 reaper 在预扣过期后释放。
const (
	compensateTimeout = 30 * time.Second
	compensateRetry   = time.Second
)

// compensateReservation 撤销一次提交结果未知的预扣：PG 可能已经提交，但请求已被拒绝、永远不会结算，
// 不补偿的话这笔额度要冻结到 reservation_ttl 才由 reaper 释放。释放按 requestID 幂等，预扣实际未提交时什么也不做。
func (l *Ledger) compensateReservation(ctx context.Context, requestID string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), compensateTimeout)
	defer cancel()
	released, err := l.store.ReleaseReservation(ctx, requestID)
	for err != nil && ctx.Err() == nil {
		select {
		case <-ctx.Done():
		case <-time.After(compensateRetry):
			released, err = l.store.ReleaseReservation(ctx, requestID)
		}
	}
	switch {
	case err != nil:
		l.metrics.ReserveCompensations.WithLabelValues("failed").Inc()
		l.log.Warn(
			"compensate reservation failed; the reaper releases it after expiry",
			"request_id", requestID,
			"err", err,
		)
	case released:
		l.metrics.ReserveCompensations.WithLabelValues("released").Inc()
		l.log.Info("released reservation whose commit outcome was unknown", "request_id", requestID)
	default:
		l.metrics.ReserveCompensations.WithLabelValues("absent").Inc()
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
