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
	File  map[string]pricing.ModelRate `json:"configmap"` // pricing.yaml
	Store []store.ModelPrice           `json:"pg"`        // PG 兜底表
}

// Pricing 返回 pricing.yaml 与 PG 兜底表的定价。
func (s *Service) Pricing(ctx context.Context) (PricingView, error) {
	rows, err := s.store.ListModelPricing(ctx)
	if err != nil {
		return PricingView{}, err
	}
	return PricingView{File: s.prices.PriceConfig().Models, Store: rows}, nil
}

// ModelPriceInput 写入 PG 兜底定价的参数。
// 倍率未填写时取 1；0 表示免费；负数无效。填写 model_price（含 0）时按次计费。
type ModelPriceInput struct {
	ModelRatio          *float64 `json:"model_ratio"           yaml:"model_ratio"`
	CompletionRatio     *float64 `json:"completion_ratio"      yaml:"completion_ratio"`
	CacheRatio          *float64 `json:"cache_ratio"           yaml:"cache_ratio"`
	ModelPrice          *float64 `json:"model_price"           yaml:"model_price"`
	ReserveInputTokens  *int     `json:"reserve_input_tokens"  yaml:"reserve_input_tokens"`
	ReserveOutputTokens *int     `json:"reserve_output_tokens" yaml:"reserve_output_tokens"`
}

// modelPrice 补齐未填写的倍率并校验取值。
func (in ModelPriceInput) modelPrice(model string) (store.ModelPrice, error) {
	if model == "" {
		return store.ModelPrice{}, fmt.Errorf("%w: model is required", ErrInvalidInput)
	}
	price := store.ModelPrice{
		Model:               model,
		ModelRatio:          ratioOrDefault(in.ModelRatio),
		CompletionRatio:     ratioOrDefault(in.CompletionRatio),
		CacheRatio:          ratioOrDefault(in.CacheRatio),
		ModelPrice:          in.ModelPrice,
		ReserveInputTokens:  in.ReserveInputTokens,
		ReserveOutputTokens: in.ReserveOutputTokens,
	}
	if err := pricing.ValidateModelPrice(price); err != nil {
		return store.ModelPrice{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
	}
	return price, nil
}

// UpsertModelPrice 写入 PG 兜底定价并清除查价缓存。
func (s *Service) UpsertModelPrice(ctx context.Context, model string, in ModelPriceInput) error {
	price, err := in.modelPrice(model)
	if err != nil {
		return err
	}
	if err := s.store.UpsertModelPricing(ctx, price); err != nil {
		return err
	}
	s.caches.InvalidateModelPrice(ctx, model)
	return nil
}

// ratioOrDefault 未填写的倍率取 1（与 model_pricing 列默认值一致）。
func ratioOrDefault(v *float64) float64 {
	if v == nil {
		return 1
	}
	return *v
}

// DeleteModelPrice 删除 PG 兜底定价并清除查价缓存。
func (s *Service) DeleteModelPrice(ctx context.Context, model string) error {
	if err := s.store.DeleteModelPricing(ctx, model); err != nil {
		return err
	}
	s.caches.InvalidateModelPrice(ctx, model)
	return nil
}

// AgentGatewayCatalog 渲染网关 modelCatalog。
func (s *Service) AgentGatewayCatalog(ctx context.Context) (pricing.AgentGatewayCatalog, error) {
	return s.prices.AgentGatewayCatalog(ctx)
}

// UsageTotals 用量聚合的合计。
type UsageTotals struct {
	Requests              int64 `json:"requests"`
	CostNanos             int64 `json:"cost_nanos"`
	AgentGatewayCostNanos int64 `json:"gateway_cost_nanos"`
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
		totals.AgentGatewayCostNanos += r.AgentGatewayCostNanos
	}
	return rows, totals, nil
}

// ListUsage 列出用量明细。
func (s *Service) ListUsage(
	ctx context.Context,
	apiKeyID *uuid.UUID,
	since *time.Time,
	limit int,
) ([]store.UsageEvent, error) {
	return s.store.ListUsage(ctx, apiKeyID, since, limit)
}

// ListAudit 列出准入审计。
func (s *Service) ListAudit(ctx context.Context, apiKeyID *uuid.UUID, limit int) ([]store.Audit, error) {
	return s.store.ListAudit(ctx, apiKeyID, limit)
}

// ListReservations 列出未结算的预扣。
func (s *Service) ListReservations(ctx context.Context, limit int) ([]store.Reservation, error) {
	return s.store.ListReservations(ctx, limit)
}
