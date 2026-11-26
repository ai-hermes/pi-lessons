package postgres

import (
	"context"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// PG 兜底定价表 model_pricing。

// ListModelPricing 见 store.Store。
func (d *DB) ListModelPricing(ctx context.Context) ([]store.ModelPrice, error) {
	rows, err := d.q.ListModelPricing(ctx)
	if err != nil {
		return nil, d.fail("ListModelPricing", err)
	}
	return mapRows(rows, toModelPrice), nil
}

// GetModelPricing 见 store.Store。
func (d *DB) GetModelPricing(ctx context.Context, model string) (store.ModelPrice, error) {
	row, err := d.q.GetModelPricing(ctx, model)
	return toModelPrice(row), d.fail("GetModelPricing", err)
}

// UpsertModelPricing 见 store.Store。
func (d *DB) UpsertModelPricing(ctx context.Context, p store.ModelPrice) error {
	err := d.q.UpsertModelPricing(ctx, sqlcgen.UpsertModelPricingParams{
		Model:               p.Model,
		ModelRatio:          p.ModelRatio,
		CompletionRatio:     p.CompletionRatio,
		CacheRatio:          p.CacheRatio,
		ModelPrice:          p.ModelPrice,
		ReserveInputTokens:  p.ReserveInputTokens,
		ReserveOutputTokens: p.ReserveOutputTokens,
	})
	return d.fail("UpsertModelPricing", err)
}

// DeleteModelPricing 见 store.Store。
func (d *DB) DeleteModelPricing(ctx context.Context, model string) error {
	return d.fail("DeleteModelPricing", d.q.DeleteModelPricing(ctx, model))
}
