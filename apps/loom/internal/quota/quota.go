// Package quota 实现鉴权阶段的两级额度预扣、过期释放；结算在 billing 收到 usage 后调用。
package quota

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// Service 额度服务。
type Service struct {
	cfg config.Quota
	st  store.Store
	m   *telemetry.Metrics
	log *slog.Logger
}

// NewService 创建服务。
func NewService(cfg config.Quota, st store.Store, m *telemetry.Metrics, log *slog.Logger) *Service {
	return &Service{cfg: cfg, st: st, m: m, log: log}
}

// ReserveResult 预扣后的额度快照。
type ReserveResult struct {
	Nanos        int64
	KeyState     store.QuotaState
	AccountState store.QuotaState
}

// Remaining 两级额度中的最小剩余值；两级都不限时返回 false。
func (r ReserveResult) Remaining() (int64, bool) {
	k, kok := r.KeyState.Remaining()
	a, aok := r.AccountState.Remaining()
	switch {
	case kok && aok:
		return min(k, a), true
	case kok:
		return k, true
	case aok:
		return a, true
	}
	return 0, false
}

// Reserve 对 Key 与账户做原子预扣，并写入预扣记录。额度不足返回 loom.ErrInsufficientQuota。
func (s *Service) Reserve(ctx context.Context, key store.Key, card pricing.PriceCard, requestID string, now time.Time) (ReserveResult, error) {
	res := ReserveResult{Nanos: card.ReserveNanos}
	ks, err := s.st.ReserveKeyQuota(ctx, key.ID, card.ReserveNanos)
	if err != nil {
		return res, err
	}
	res.KeyState = ks
	as, err := s.st.ReserveAccountQuota(ctx, key.AccountID, card.ReserveNanos)
	if err != nil {
		if card.ReserveNanos > 0 {
			if rerr := s.st.ReleaseKeyReservation(ctx, key.ID, card.ReserveNanos); rerr != nil {
				s.log.Error("release key reservation after account failure", "err", rerr, "key_id", key.ID)
			}
		}
		return res, err
	}
	res.AccountState = as
	if card.ReserveNanos > 0 {
		exp := now
		if s.cfg.ReservationTTL > 0 {
			exp = now.Add(s.cfg.ReservationTTL)
		}
		if err := s.st.CreateReservation(ctx, store.Reservation{RequestID: requestID, KeyID: key.ID, AccountID: key.AccountID,
			Model: card.Model, Nanos: card.ReserveNanos, ExpiresAt: exp, CreatedAt: now}); err != nil {
			if rerr := s.st.ReleaseKeyReservation(ctx, key.ID, card.ReserveNanos); rerr != nil {
				s.log.Error("release key reservation failed", "err", rerr)
			}
			if aerr := s.st.ReleaseAccountReservation(ctx, key.AccountID, card.ReserveNanos); aerr != nil {
				s.log.Error("release account reservation failed", "err", aerr)
			}
			return res, err
		}
	}
	if s.m != nil {
		s.m.QuotaReserved.WithLabelValues(card.Model).Add(float64(card.ReserveNanos))
	}
	return res, nil
}

// Reaper 周期释放过期预扣；阻塞直到 ctx 结束。
func (s *Service) Reaper(ctx context.Context) {
	interval := s.cfg.ReaperInterval
	if interval <= 0 {
		interval = time.Minute
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := s.st.ReleaseExpiredReservations(ctx, time.Now(), s.cfg.ReaperBatch)
			if err != nil {
				s.log.Warn("release expired reservations failed", "err", err)
				continue
			}
			if n > 0 {
				if s.m != nil {
					s.m.ReservationsExpired.Add(float64(n))
				}
				s.log.Warn("released expired reservations", "count", n)
			}
		}
	}
}

// RefreshOpenGauge 刷新预扣存量指标。
func (s *Service) RefreshOpenGauge(ctx context.Context) {
	if s.m == nil {
		return
	}
	n, err := s.st.CountReservations(ctx)
	if err == nil {
		s.m.ReservationsOpen.Set(float64(n))
	}
}

// RefreshAccountGauges 刷新有额度上限的账户余额指标。
func (s *Service) RefreshAccountGauges(ctx context.Context) {
	if s.m == nil {
		return
	}
	accounts, err := s.st.ListAccounts(ctx, 1000)
	if err != nil {
		return
	}
	for _, a := range accounts {
		if r, ok := a.Remaining(); ok {
			s.m.QuotaRemaining.WithLabelValues(a.Name).Set(float64(r))
		}
	}
}

// ErrInsufficient 判断是否额度不足。
func IsInsufficient(err error) bool { return errors.Is(err, loom.ErrInsufficientQuota) }

// FindReservation 供测试与查询。
func (s *Service) FindReservation(ctx context.Context, id string) (store.Reservation, error) {
	return s.st.GetReservation(ctx, id)
}
