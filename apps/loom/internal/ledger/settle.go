package ledger

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// Usage 是一次请求的用量上报，来自网关 RLS amend 或 OTLP access log。
// 同一 RequestID 只会结算一次，后到的上报只补写网关金额。
type Usage struct {
	RequestID string
	Channel   string // 上报通道，仅用于指标与日志：rls | otlp

	// 归属：优先 KeyID；没有 KeyID 时按账户名归属（无预扣的旧流量）。
	KeyID       uuid.UUID
	AccountName string

	Model  string
	Tokens pricing.Tokens
	// GatewayCostNanos 网关按其 modelCatalog 算出的金额，仅用于对账。
	GatewayCostNanos *int64

	Time     time.Time
	TraceID  string
	SpanID   string
	Provider string
	Route    string
	Gateway  string
}

// Settle 按实际用量结算一次请求：解析归属 → 定价 → 对账 → 落库并冲正预扣。
// 返回 inserted=false 表示该请求已被另一通道结算过。
func (l *Ledger) Settle(ctx context.Context, u Usage) (inserted bool, err error) {
	defer func() {
		if err != nil {
			l.metrics.SettleErrors.WithLabelValues(u.Channel).Inc()
		}
	}()

	o, err := l.owners.resolve(ctx, u)
	if err != nil {
		return false, fmt.Errorf("resolve owner: %w", err)
	}
	cost, source, err := l.price(ctx, u, o)
	if err != nil {
		return false, fmt.Errorf("price usage: %w", err)
	}

	inserted, err = l.store.SettleUsage(ctx, usageEvent(u, o, cost, source))
	if err != nil {
		return false, fmt.Errorf("persist usage: %w", err)
	}
	if !inserted {
		l.backfillGatewayCost(ctx, u)
	}

	l.metrics.Settlements.WithLabelValues(u.Channel, strconv.FormatBool(inserted)).Inc()
	if inserted {
		l.metrics.SettledNanos.WithLabelValues(u.Model).Add(float64(cost))
	}
	l.log.Info("usage settled",
		"channel", u.Channel,
		"inserted", inserted,
		"request_id", u.RequestID,
		"model", u.Model,
		"input", u.Tokens.Input,
		"cached", u.Tokens.Cached,
		"output", u.Tokens.Output,
		"cost_nanos", cost,
		"pricing_source", source,
	)
	return inserted, nil
}

// price 计算结算金额；未定价模型金额为 0（准入阶段已拦截，这里只记账）。
func (l *Ledger) price(ctx context.Context, u Usage, o owner) (int64, pricing.Source, error) {
	card, err := l.pricer.Lookup(ctx, u.Model, o.group)
	if errors.Is(err, pricing.ErrNotPriced) {
		return 0, "", nil
	}
	if err != nil {
		return 0, "", err
	}
	cost := card.Cost(u.Tokens)

	if l.opts.CostSource == CostSourceGatewayPreferred && u.GatewayCostNanos != nil {
		return *u.GatewayCostNanos, pricingSourceGateway, nil
	}
	l.reconcile(u, card, cost)
	return cost, card.Source, nil
}

// reconcile 比对 loom 与网关金额。网关 catalog 不表达分组倍率，非 1 倍率的账户不比较。
func (l *Ledger) reconcile(u Usage, card pricing.Card, cost int64) {
	if u.GatewayCostNanos == nil || card.GroupRatio != 1 {
		return
	}
	if diff := *u.GatewayCostNanos - cost; diff >= -1 && diff <= 1 {
		return
	}
	l.metrics.CostMismatch.WithLabelValues(u.Model).Inc()
	l.log.Warn("cost mismatch between loom and gateway",
		"request_id", u.RequestID,
		"model", u.Model,
		"loom_nanos", cost,
		"gateway_nanos", *u.GatewayCostNanos,
	)
}

// backfillGatewayCost 在请求已被另一通道结算时补写网关金额，只用于对账，不影响扣费。
func (l *Ledger) backfillGatewayCost(ctx context.Context, u Usage) {
	if u.GatewayCostNanos == nil || u.RequestID == "" {
		return
	}
	if _, err := l.store.BackfillGatewayCost(ctx, u.RequestID, *u.GatewayCostNanos); err != nil {
		l.log.Warn("backfill gateway cost failed", "err", err, "request_id", u.RequestID)
	}
}

func usageEvent(u Usage, o owner, cost int64, source pricing.Source) store.UsageEvent {
	ev := store.UsageEvent{
		Time:             u.Time,
		RequestID:        u.RequestID,
		TraceID:          u.TraceID,
		SpanID:           u.SpanID,
		Model:            u.Model,
		Provider:         u.Provider,
		Route:            u.Route,
		Gateway:          u.Gateway,
		InputTokens:      u.Tokens.Input,
		OutputTokens:     u.Tokens.Output,
		CachedTokens:     u.Tokens.Cached,
		CostNanos:        cost,
		GatewayCostNanos: u.GatewayCostNanos,
		PricingSource:    string(source),
	}
	if ev.Time.IsZero() {
		ev.Time = time.Now()
	}
	if o.keyID != uuid.Nil {
		ev.KeyID = &o.keyID
	}
	if o.accountID != uuid.Nil {
		ev.AccountID = &o.accountID
	}
	return ev
}
