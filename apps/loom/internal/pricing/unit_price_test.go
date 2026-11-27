package pricing

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const examplePricing = `
defaults: {model_ratio: 1, completion_ratio: 1, cache_ratio: 1, unknown_model: deny}
groups:
  default: {ratio: 1}
  vip: {ratio: 0.9}
models:
  doubao-seed-2.1-lite:    {model_ratio: 0.15, completion_ratio: 2, cache_ratio: 0.1}
  doubao-seedream-5.0-pro: {model_price: 0.04}
`

func unitPriceFor(t *testing.T, priceConfig *PriceConfig, model, group string, reserve ReserveEstimate) UnitPrice {
	t.Helper()
	m, ok := priceConfig.Models[model]
	require.True(t, ok, "model %q not in priceConfig", model)
	return newUnitPrice(unitPriceInput{
		model:      model,
		group:      group,
		groupRatio: priceConfig.GroupRatio(group),
		rate:       m,
		reserve:    reserve,
		source:     SourceConfigMap,
	})
}

func TestUnitPriceCostFollowsOneAPIFormula(t *testing.T) {
	priceConfig, err := ParsePriceConfig([]byte(examplePricing))
	require.NoError(t, err)

	reserve := ReserveEstimate{Input: 1024, Output: 1024}
	unitPrice := unitPriceFor(t, priceConfig, "doubao-seed-2.1-lite", "default", reserve)

	assert.False(t, unitPrice.IsPerCall())
	assert.InDelta(t, 300.0, unitPrice.InputNanos, 1e-9, "0.15 × 2000")
	assert.InDelta(t, 30.0, unitPrice.CachedNanos, 1e-9, "× cache_ratio 0.1")
	assert.InDelta(t, 600.0, unitPrice.OutputNanos, 1e-9, "× completion_ratio 2")
	assert.Equal(t, int64(546_000), unitPrice.Cost(TokenUsage{Input: 1000, Cached: 200, Output: 500}))
	assert.Equal(t, int64(921_600), unitPrice.ReserveNanos, "1024 × 300 + 1024 × 600")
}

func TestUnitPriceCostPlanExample(t *testing.T) {
	unitPrice := newUnitPrice(unitPriceInput{
		model:      "m",
		groupRatio: 1,
		rate:       ModelRate{ModelRatio: 0.5, CompletionRatio: 2, CacheRatio: 0.1},
		reserve:    ReserveEstimate{Input: 1024, Output: 1024},
	})

	assert.InDelta(t, 1000.0, unitPrice.InputNanos, 1e-9)
	assert.InDelta(t, 100.0, unitPrice.CachedNanos, 1e-9)
	assert.InDelta(t, 2000.0, unitPrice.OutputNanos, 1e-9)
	assert.Equal(t, int64(1_820_000), unitPrice.Cost(TokenUsage{Input: 1000, Cached: 200, Output: 500}))
}

func TestUnitPricePerCall(t *testing.T) {
	priceConfig, err := ParsePriceConfig([]byte(examplePricing))
	require.NoError(t, err)

	tests := []struct {
		group    string
		expected int64
	}{
		{group: "default", expected: 40_000_000},
		{group: "vip", expected: 36_000_000},
	}
	for _, tt := range tests {
		t.Run(tt.group, func(t *testing.T) {
			unitPrice := unitPriceFor(t, priceConfig, "doubao-seedream-5.0-pro", tt.group, ReserveEstimate{})
			assert.True(t, unitPrice.IsPerCall())
			assert.Equal(t, tt.expected, unitPrice.Cost(TokenUsage{}))
			assert.Equal(t, tt.expected, unitPrice.ReserveNanos)
		})
	}
}

func TestUnitPriceCachedNeverExceedsInput(t *testing.T) {
	unitPrice := UnitPrice{InputNanos: 10, CachedNanos: 1, OutputNanos: 20}
	assert.Equal(t, int64(5*1+2*20), unitPrice.Cost(TokenUsage{Input: 5, Cached: 9, Output: 2}))
}

func TestParsePriceConfigDefaults(t *testing.T) {
	priceConfig, err := ParsePriceConfig([]byte("models:\n  a: {}\n"))
	require.NoError(t, err)

	assert.InDelta(t, 1.0, priceConfig.Defaults.ModelRatio, 1e-9)
	assert.Equal(t, UnknownDeny, priceConfig.Defaults.UnknownModel)
	assert.InDelta(t, 1.0, priceConfig.GroupRatio("default"), 1e-9)
	assert.InDelta(t, 2000.0, unitPriceFor(t, priceConfig, "a", "default", ReserveEstimate{}).InputNanos, 1e-9)
}

func TestParsePriceConfigRejectsUnknownPolicy(t *testing.T) {
	_, err := ParsePriceConfig([]byte("defaults: {unknown_model: allow}\n"))
	assert.Error(t, err)
}

func TestMergeReserveEstimateOverride(t *testing.T) {
	global := ReserveEstimate{Input: 1024, Output: 1024}
	assert.Equal(t, global, mergeReserveEstimate(global, nil))
	override := &ReserveEstimate{Input: -1, Output: 8}
	assert.Equal(t, ReserveEstimate{Input: 1024, Output: 8}, mergeReserveEstimate(global, override))
}
