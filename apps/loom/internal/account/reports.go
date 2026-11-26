package account

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// PricingView 两处定价来源的当前内容。
type PricingView struct {
	File  map[string]pricing.ModelSpec `json:"configmap"` // pricing.yaml
	Store []store.ModelPrice           `json:"pg"`        // PG 兜底表
}

// Pricing 返回 pricing.yaml 与 PG 兜底表的定价。
func (s *Service) Pricing(ctx context.Context) (PricingView, error) {
	rows, err := s.store.ListModelPricing(ctx)
	if err != nil {
		return PricingView{}, err
	}
	return PricingView{File: s.prices.Spec().Models, Store: rows}, nil
}

// UpsertStorePrice 写入 PG 兜底定价并清除查价缓存。
func (s *Service) UpsertStorePrice(ctx context.Context, p store.ModelPrice) error {
	if p.Model == "" {
		return fmt.Errorf("%w: model is required", ErrInvalidInput)
	}
	if err := s.store.UpsertModelPricing(ctx, p); err != nil {
		return err
	}
	s.prices.InvalidateStoreCache(p.Model)
	return nil
}

// DeleteStorePrice 删除 PG 兜底定价并清除查价缓存。
func (s *Service) DeleteStorePrice(ctx context.Context, model string) error {
	if err := s.store.DeleteModelPricing(ctx, model); err != nil {
		return err
	}
	s.prices.InvalidateStoreCache(model)
	return nil
}

// GatewayCatalog 渲染网关 modelCatalog。
func (s *Service) GatewayCatalog(ctx context.Context) (pricing.GatewayCatalog, error) {
	return s.prices.GatewayCatalog(ctx)
}

// UsageTotals 用量聚合的合计。
type UsageTotals struct {
	Requests         int64 `json:"requests"`
	CostNanos        int64 `json:"cost_nanos"`
	GatewayCostNanos int64 `json:"gateway_cost_nanos"`
}

// UsageSummary 按账户 / Key / 模型聚合的用量及合计。
func (s *Service) UsageSummary(ctx context.Context, f store.UsageFilter) ([]store.UsageSummaryRow, UsageTotals, error) {
	rows, err := s.store.SummaryUsage(ctx, f)
	if err != nil {
		return nil, UsageTotals{}, err
	}
	var totals UsageTotals
	for _, r := range rows {
		totals.Requests += r.Requests
		totals.CostNanos += r.CostNanos
		totals.GatewayCostNanos += r.GatewayCostNanos
	}
	return rows, totals, nil
}

// ListUsage 列出用量明细。
func (s *Service) ListUsage(
	ctx context.Context,
	keyID *uuid.UUID,
	since *time.Time,
	limit int,
) ([]store.UsageEvent, error) {
	return s.store.ListUsage(ctx, keyID, since, limit)
}

// ListAudit 列出准入审计。
func (s *Service) ListAudit(ctx context.Context, keyID *uuid.UUID, limit int) ([]store.Audit, error) {
	return s.store.ListAudit(ctx, keyID, limit)
}

// ListReservations 列出未结算的预扣。
func (s *Service) ListReservations(ctx context.Context, limit int) ([]store.Reservation, error) {
	return s.store.ListReservations(ctx, limit)
}
