package ledger

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// UsageReport 是一次请求的用量上报，来自网关 RLS amend 或 OTLP access log。
// 同一 RequestID 只会结算一次，后到的上报只补写网关金额。
type UsageReport struct {
	RequestID string
	Channel   string // 上报通道，仅用于指标与日志：rls | otlp

	// 归属：优先 APIKeyID；没有 APIKeyID 时按账户名归属（无预扣的旧流量）。
	APIKeyID    uuid.UUID
	AccountName string

	Model      string
	TokenUsage pricing.TokenUsage
	// AgentGatewayCostNanos 网关按其 modelCatalog 算出的金额，仅用于对账。
	AgentGatewayCostNanos *int64

	Time         time.Time
	TraceID      string
	SpanID       string
	Provider     string
	Route        string
	AgentGateway string
}

// Settle 按实际用量结算一次请求：解析归属 → 定价 → 对账 → 落库并冲正预扣。
// 返回 inserted=false 表示该请求已被另一通道结算过。
func (l *Ledger) Settle(ctx context.Context, report UsageReport) (inserted bool, err error) {
	defer func() {
		if err != nil {
			l.metrics.SettleErrors.WithLabelValues(report.Channel).Inc()
		}
	}()

	owner, err := l.owners.resolve(ctx, report)
	if err != nil {
		return false, fmt.Errorf("resolve usage owner: %w", err)
	}
	cost, err := l.calculateCost(ctx, report, owner)
	if err != nil {
		return false, fmt.Errorf("price usage: %w", err)
	}

	inserted, err = l.store.SettleUsage(ctx, usageEvent(report, owner, cost))
	if err != nil {
		return false, fmt.Errorf("persist usage: %w", err)
	}
	if !inserted {
		l.backfillAgentGatewayCost(ctx, report)
	}

	l.metrics.Settlements.WithLabelValues(report.Channel, strconv.FormatBool(inserted)).Inc()
	if inserted {
		l.metrics.SettledNanos.WithLabelValues(report.Model).Add(float64(cost.nanos))
		l.correctTokenEstimate(ctx, report, owner, cost)
	}
	l.log.Info(
		"usage settled",
		"channel", report.Channel,
		"inserted", inserted,
		"request_id", report.RequestID,
		"model", report.Model,
		"input", report.TokenUsage.Input,
		"cached", report.TokenUsage.Cached,
		"output", report.TokenUsage.Output,
		"cost_nanos", cost.nanos,
		"pricing_source", cost.source,
	)
	return inserted, nil
}

// correctTokenEstimate 准入时按预扣估值计入了 TPM，这里补上实际与估值的差额（失败的请求实际为 0，相当于退回估值）。
func (l *Ledger) correctTokenEstimate(ctx context.Context, report UsageReport, owner usageOwner, cost settlementCost) {
	if l.tokens == nil || owner.apiKey.ID == uuid.Nil {
		return
	}
	var estimated int64
	if cost.unitPrice != nil {
		estimated = cost.unitPrice.ReserveTokens
	}
	actual := report.TokenUsage.Input + report.TokenUsage.Output
	l.tokens.AdjustTokens(ctx, owner.apiKey, actual-estimated)
}

// settlementCost 是一次结算的金额及其来源；unitPrice 为 nil 表示模型未定价（金额为 0）。
type settlementCost struct {
	nanos     int64
	source    pricing.PriceSource
	unitPrice *pricing.UnitPrice
}

// calculateCost 计算结算金额。
//   - 模型未定价：金额为 0（准入阶段已拦截，这里只记账）。
//   - 分组未定义（准入后 pricing.yaml 删除了该分组）：按 default 分组结算，避免已发生的调用变成 0 元。
//   - cost_source 为 gateway_prefer 且网关上报了金额：网关金额 × 分组倍率（网关 catalog 不含分组倍率）。
func (l *Ledger) calculateCost(ctx context.Context, report UsageReport, owner usageOwner) (settlementCost, error) {
	unitPrice, err := l.pricer.Lookup(ctx, report.Model, owner.group)
	if errors.Is(err, pricing.ErrGroupNotPriced) {
		l.log.Warn(
			"settling usage of an undefined group at the default group price",
			"request_id", report.RequestID,
			"group", owner.group,
		)
		unitPrice, err = l.pricer.Lookup(ctx, report.Model, pricing.DefaultGroup)
	}
	if errors.Is(err, pricing.ErrNotPriced) {
		return settlementCost{}, nil
	}
	if err != nil {
		return settlementCost{}, err
	}

	cost := settlementCost{
		nanos:     unitPrice.Cost(report.TokenUsage),
		source:    unitPrice.PriceSource,
		unitPrice: &unitPrice,
	}
	agentGatewayNanos, hasAgentGatewayCost := agentGatewayCostWithGroupRatio(report, unitPrice)
	if !hasAgentGatewayCost {
		return cost, nil
	}
	if l.opts.CostSource == CostSourceAgentGatewayPreferred {
		cost.nanos, cost.source = agentGatewayNanos, pricingSourceAgentGateway
		return cost, nil
	}
	l.reconcileAgentGatewayCost(report, cost.nanos, agentGatewayNanos)
	return cost, nil
}

// agentGatewayCostWithGroupRatio 把网关上报的金额乘上分组倍率；网关按 1 倍 catalog 计价，不含分组倍率。
func agentGatewayCostWithGroupRatio(report UsageReport, unitPrice pricing.UnitPrice) (int64, bool) {
	if report.AgentGatewayCostNanos == nil {
		return 0, false
	}
	return int64(math.Round(float64(*report.AgentGatewayCostNanos) * unitPrice.GroupRatio)), true
}

// reconcileAgentGatewayCost 比对 loom 与网关金额（均已含分组倍率），允许 1 nano 的取整误差。
func (l *Ledger) reconcileAgentGatewayCost(report UsageReport, loomNanos, agentGatewayNanos int64) {
	if diff := agentGatewayNanos - loomNanos; diff >= -1 && diff <= 1 {
		return
	}
	l.metrics.CostMismatch.WithLabelValues(report.Model).Inc()
	l.log.Warn(
		"cost mismatch between loom and agentgateway",
		"request_id", report.RequestID,
		"model", report.Model,
		"loom_nanos", loomNanos,
		"agentgateway_nanos", agentGatewayNanos,
	)
}

// backfillAgentGatewayCost 在请求已被另一通道结算时补写网关金额，只用于对账，不影响扣费。
func (l *Ledger) backfillAgentGatewayCost(ctx context.Context, report UsageReport) {
	if report.AgentGatewayCostNanos == nil || report.RequestID == "" {
		return
	}
	if _, err := l.store.BackfillAgentGatewayCost(ctx, report.RequestID, *report.AgentGatewayCostNanos); err != nil {
		l.log.Warn("backfill agentgateway cost failed", "err", err, "request_id", report.RequestID)
	}
}

// usageEvent 组装账单明细；带上计价快照（分组与倍率），事后可以复核每一笔金额。
// 用量时间与结算时刻相差超过这个范围时按结算时刻记账：零值、时钟偏差或极晚到达的上报会落进不存在的分区，
// 或落到已经汇总过、不再重算的日子（汇总每轮只重算水位线前一天）。
const (
	maxUsageTimeLag  = time.Hour
	maxUsageTimeLead = 5 * time.Minute
)

// usageTime 返回落库用的用量时间。
func usageTime(reported, now time.Time) time.Time {
	if reported.Before(now.Add(-maxUsageTimeLag)) || reported.After(now.Add(maxUsageTimeLead)) {
		return now
	}
	return reported
}

func usageEvent(report UsageReport, owner usageOwner, cost settlementCost) store.UsageEvent {
	ev := store.UsageEvent{
		Time:                  usageTime(report.Time, time.Now()),
		RequestID:             report.RequestID,
		TraceID:               report.TraceID,
		SpanID:                report.SpanID,
		Model:                 report.Model,
		Provider:              report.Provider,
		Route:                 report.Route,
		AgentGateway:          report.AgentGateway,
		InputTokens:           report.TokenUsage.Input,
		OutputTokens:          report.TokenUsage.Output,
		CachedTokens:          report.TokenUsage.Cached,
		CostNanos:             cost.nanos,
		AgentGatewayCostNanos: report.AgentGatewayCostNanos,
		PricingSource:         string(cost.source),
	}
	if unitPrice := cost.unitPrice; unitPrice != nil {
		ev.Pricing = &store.PricingSnapshot{
			Group:           unitPrice.Group,
			GroupRatio:      unitPrice.GroupRatio,
			ModelRatio:      unitPrice.ModelRatio,
			CompletionRatio: unitPrice.CompletionRatio,
			CacheRatio:      unitPrice.CacheRatio,
			ModelPrice:      unitPrice.ModelPrice,
		}
	}
	if ev.Time.IsZero() {
		ev.Time = time.Now()
	}
	if owner.apiKeyID != uuid.Nil {
		ev.APIKeyID = &owner.apiKeyID
	}
	if owner.accountID != uuid.Nil {
		ev.AccountID = &owner.accountID
	}
	return ev
}
