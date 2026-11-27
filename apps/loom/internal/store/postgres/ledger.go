package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// 额度预扣、结算与过期释放。

// GetReservation 见 store.Store。
func (d *DB) GetReservation(ctx context.Context, requestID string) (store.Reservation, error) {
	row, err := d.q.GetReservation(ctx, requestID)
	return toReservation(row), d.fail("Reservation", err)
}

// ListReservations 见 store.Store。
func (d *DB) ListReservations(ctx context.Context, limit int) ([]store.Reservation, error) {
	rows, err := d.q.ListReservations(ctx, queryLimit(limit))
	if err != nil {
		return nil, d.fail("ListReservations", err)
	}
	return mapRows(rows, toReservation), nil
}

// CountReservations 见 store.Store。
func (d *DB) CountReservations(ctx context.Context) (int64, error) {
	n, err := d.q.CountReservations(ctx)
	return n, d.fail("CountReservations", err)
}

// SettleUsage 见 store.Store：在一个事务内幂等插入用量，并把预扣冲正为实际金额。
func (d *DB) SettleUsage(ctx context.Context, ev store.UsageEvent) (inserted bool, err error) {
	err = d.inTx(ctx, "SettleUsage", func(q *sqlcgen.Queries) error {
		_, err := q.SettleUsage(ctx, usageEventParams(ev))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // request_id 已结算过：重复投递，不重复扣费
		}
		if err != nil {
			return d.fail("SettleUsage.insert", err)
		}
		inserted = true
		return d.chargeQuota(ctx, q, ev)
	})
	return inserted, err
}

// chargeQuota 有预扣记录时用实际金额冲正预扣；没有时（预扣为 0、已过期释放）直接累加已用额度。
func (d *DB) chargeQuota(ctx context.Context, q *sqlcgen.Queries, ev store.UsageEvent) error {
	if ev.APIKeyID == nil {
		if ev.AccountID == nil {
			return nil
		}
		err := q.AddAccountUsed(ctx, sqlcgen.AddAccountUsedParams{ID: *ev.AccountID, QuotaUsed: ev.CostNanos})
		return d.fail("SettleUsage.addAccountUsed", err)
	}

	// 锁住预扣记录：与 reaper、补偿释放互斥，同一笔预扣不会被结算和释放各扣回一次
	res, err := q.LockReservation(ctx, ev.RequestID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := q.AddKeyUsed(ctx, sqlcgen.AddKeyUsedParams{ID: *ev.APIKeyID, QuotaUsed: ev.CostNanos}); err != nil {
			return d.fail("SettleUsage.addKeyUsed", err)
		}
		if ev.AccountID == nil {
			return nil
		}
		err := q.AddAccountUsed(ctx, sqlcgen.AddAccountUsedParams{ID: *ev.AccountID, QuotaUsed: ev.CostNanos})
		return d.fail("SettleUsage.addAccountUsed", err)
	}
	if err != nil {
		return d.fail("SettleUsage.getReservation", err)
	}

	keyParams := sqlcgen.SettleKeyQuotaParams{ID: res.KeyID, Reserved: res.Nanos, QuotaUsed: ev.CostNanos}
	if err := q.SettleKeyQuota(ctx, keyParams); err != nil {
		return d.fail("SettleUsage.settleKey", err)
	}
	accountParams := sqlcgen.SettleAccountQuotaParams{ID: res.AccountID, Reserved: res.Nanos, QuotaUsed: ev.CostNanos}
	if err := q.SettleAccountQuota(ctx, accountParams); err != nil {
		return d.fail("SettleUsage.settleAccount", err)
	}
	return d.fail("SettleUsage.deleteReservation", q.DeleteReservation(ctx, ev.RequestID))
}

// ReleaseExpiredReservations 见 store.Store：SKIP LOCKED 保证多副本并发执行时不重复释放。
func (d *DB) ReleaseExpiredReservations(ctx context.Context, now time.Time, limit int) (released int, err error) {
	err = d.inTx(ctx, "ReleaseExpired", func(q *sqlcgen.Queries) error {
		rows, err := q.LockExpiredReservations(ctx, sqlcgen.LockExpiredReservationsParams{
			ExpiresAt: now,
			Limit:     queryLimit(limit),
		})
		if err != nil {
			return d.fail("ReleaseExpired.lock", err)
		}
		for _, r := range rows {
			keyParams := sqlcgen.ReleaseKeyReservationParams{ID: r.KeyID, Reserved: r.Nanos}
			if err := q.ReleaseKeyReservation(ctx, keyParams); err != nil {
				return d.fail("ReleaseExpired.releaseKey", err)
			}
			accountParams := sqlcgen.ReleaseAccountReservationParams{ID: r.AccountID, Reserved: r.Nanos}
			if err := q.ReleaseAccountReservation(ctx, accountParams); err != nil {
				return d.fail("ReleaseExpired.releaseAccount", err)
			}
			if err := q.DeleteReservation(ctx, r.RequestID); err != nil {
				return d.fail("ReleaseExpired.delete", err)
			}
		}
		released = len(rows)
		return nil
	})
	return released, err
}

func usageEventParams(ev store.UsageEvent) sqlcgen.SettleUsageParams {
	if ev.Time.IsZero() {
		ev.Time = time.Now() // 与 memstore 一致；零值会落到不存在的分区
	}
	params := sqlcgen.SettleUsageParams{
		Time:             ev.Time,
		RequestID:        optionalText(ev.RequestID),
		TraceID:          ev.TraceID,
		SpanID:           ev.SpanID,
		AccountID:        ev.AccountID,
		KeyID:            ev.APIKeyID,
		Model:            ev.Model,
		Provider:         ev.Provider,
		Route:            ev.Route,
		Gateway:          ev.AgentGateway,
		InputTokens:      ev.InputTokens,
		OutputTokens:     ev.OutputTokens,
		CachedTokens:     ev.CachedTokens,
		CostNanos:        ev.CostNanos,
		GatewayCostNanos: ev.AgentGatewayCostNanos,
		PricingSource:    ev.PricingSource,
		BillingBasis:     string(orUsage(ev.BillingBasis)),
	}
	if snap := ev.Pricing; snap != nil {
		params.PricingGroup = optionalText(snap.Group)
		params.GroupRatio = &snap.GroupRatio
		params.ModelRatio = &snap.ModelRatio
		params.CompletionRatio = &snap.CompletionRatio
		params.CacheRatio = &snap.CacheRatio
		params.ModelPrice = snap.ModelPrice
	}
	return params
}

// ReserveQuota 见 store.Store：一条 SQL 完成两级预扣与预扣记录；任一级不满足时回滚事务。
func (d *DB) ReserveQuota(
	ctx context.Context,
	r store.Reservation,
	concurrency store.ConcurrencyLimits,
) (reserved store.QuotaReservation, err error) {
	err = d.inTx(ctx, "ReserveQuota", func(q *sqlcgen.Queries) error {
		row, err := q.ReserveQuota(ctx, sqlcgen.ReserveQuotaParams{
			Nanos:                 r.Nanos,
			KeyID:                 r.APIKeyID,
			KeyMaxConcurrency:     concurrency.APIKey,
			AccountID:             r.AccountID,
			AccountMaxConcurrency: concurrency.Account,
			RequestID:             r.RequestID,
			Model:                 r.Model,
			ExpiresAt:             r.ExpiresAt,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return errReserveRejected // 返回错误即回滚已执行的部分
		}
		if err != nil {
			return d.fail("ReserveQuota", err)
		}
		reserved = store.QuotaReservation{
			APIKey:  store.QuotaState{Limit: row.KeyQuotaLimit, Used: row.KeyQuotaUsed, Reserved: row.KeyReserved},
			Account: store.QuotaState{Limit: row.AccountQuotaLimit, Used: row.AccountQuotaUsed, Reserved: row.AccountReserved},
		}
		return nil
	})
	if errors.Is(err, errReserveRejected) {
		// 回滚之后再判断原因：事务内读到的 in_flight 已被本次未生效的递增改过
		return store.QuotaReservation{}, d.reserveDenied(ctx, r, concurrency)
	}
	return reserved, err
}

// errReserveRejected 条件预扣没有命中任何行（原因待 reserveDenied 判断）。
var errReserveRejected = errors.New("reserve rejected")

// reserveDenied 判断预扣失败的原因：并发已满返回 *store.RateLimitError，否则是额度不足或 Key / 账户不可用。
func (d *DB) reserveDenied(
	ctx context.Context,
	r store.Reservation,
	concurrency store.ConcurrencyLimits,
) error {
	if concurrency.APIKey == nil && concurrency.Account == nil {
		return store.ErrInsufficientQuota
	}
	inFlight, err := d.q.GetInFlight(ctx, sqlcgen.GetInFlightParams{KeyID: r.APIKeyID, AccountID: r.AccountID})
	if err != nil {
		return d.fail("ReserveQuota.inFlight", err)
	}
	switch {
	case concurrency.APIKey != nil && inFlight.KeyInFlight >= *concurrency.APIKey:
		return &store.RateLimitError{Scope: store.RateScopeAPIKey, Kind: store.RateLimitConcurrency}
	case concurrency.Account != nil && inFlight.AccountInFlight >= *concurrency.Account:
		return &store.RateLimitError{Scope: store.RateScopeAccount, Kind: store.RateLimitConcurrency}
	}
	return store.ErrInsufficientQuota
}

// ReleaseReservation 见 store.Store：锁住预扣记录后回退两级额度并删除，与 reaper、结算互斥。
func (d *DB) ReleaseReservation(ctx context.Context, requestID string) (released bool, err error) {
	err = d.inTx(ctx, "ReleaseReservation", func(q *sqlcgen.Queries) error {
		r, err := q.LockReservation(ctx, requestID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return d.fail("ReleaseReservation.lock", err)
		}
		keyParams := sqlcgen.ReleaseKeyReservationParams{ID: r.KeyID, Reserved: r.Nanos}
		if err := q.ReleaseKeyReservation(ctx, keyParams); err != nil {
			return d.fail("ReleaseReservation.releaseKey", err)
		}
		accountParams := sqlcgen.ReleaseAccountReservationParams{ID: r.AccountID, Reserved: r.Nanos}
		if err := q.ReleaseAccountReservation(ctx, accountParams); err != nil {
			return d.fail("ReleaseReservation.releaseAccount", err)
		}
		if err := q.DeleteReservation(ctx, r.RequestID); err != nil {
			return d.fail("ReleaseReservation.delete", err)
		}
		released = true
		return nil
	})
	return released, err
}

// orUsage 未指定计费依据时按 usage。
func orUsage(basis store.BillingBasis) store.BillingBasis {
	if basis == "" {
		return store.BillingByUsage
	}
	return basis
}
