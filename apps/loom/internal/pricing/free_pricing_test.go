package pricing

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 与 one-api / new-api 对齐：未填写取默认值，0 表示免费，负数是配置错误。
const freePricing = `
defaults: {model_ratio: 2, completion_ratio: 3, cache_ratio: 0.5}
groups:
  default: {ratio: 1}
  vip:     {ratio: 0.9}
  free:    {ratio: 0}
  unset:   {}
models:
  inherits:      {}
  paid:          {model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1}
  free-model:    {model_ratio: 0}
  free-output:   {model_ratio: 0.5, completion_ratio: 0}
  free-per-call: {model_price: 0}
`

func TestParsePriceConfigDistinguishesUnsetFromZero(t *testing.T) {
	priceConfig, err := ParsePriceConfig([]byte(freePricing))
	require.NoError(t, err)

	inherits := priceConfig.Models["inherits"]
	assert.InDelta(t, 2.0, inherits.ModelRatio, 1e-9, "unset model_ratio inherits defaults")
	assert.InDelta(t, 3.0, inherits.CompletionRatio, 1e-9)
	assert.InDelta(t, 0.5, inherits.CacheRatio, 1e-9)

	freeOutput := priceConfig.Models["free-output"]
	assert.InDelta(t, 0.0, freeOutput.CompletionRatio, 1e-9, "explicit 0 is kept")
	assert.InDelta(t, 0.5, freeOutput.CacheRatio, 1e-9, "other unset fields still inherit")

	assert.InDelta(t, 0.0, priceConfig.GroupRatio("free"), 1e-9)
	assert.InDelta(t, DefaultGroupRatio, priceConfig.GroupRatio("unset"), 1e-9)
}

func TestZeroMeansFree(t *testing.T) {
	priceConfig, err := ParsePriceConfig([]byte(freePricing))
	require.NoError(t, err)
	usage := TokenUsage{Input: 1000, Cached: 200, Output: 500}
	reserve := ReserveEstimate{Input: 1024, Output: 1024}

	tests := []struct {
		name          string
		model         string
		group         string
		expectedCost  int64
		expectPerCall bool
	}{
		{name: "free group on paid model", model: "paid", group: "free", expectedCost: 0},
		{name: "free model", model: "free-model", group: "default", expectedCost: 0},
		{name: "free per-call model", model: "free-per-call", group: "vip", expectedCost: 0, expectPerCall: true},
		{name: "free output only", model: "free-output", group: "default", expectedCost: 800*1000 + 200*500},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			unitPrice := unitPriceFor(t, priceConfig, tt.model, tt.group, reserve)

			assert.Equal(t, tt.expectPerCall, unitPrice.IsPerCall())
			assert.Equal(t, tt.expectedCost, unitPrice.Cost(usage))
			if tt.expectedCost == 0 {
				assert.Zero(t, unitPrice.ReserveNanos, "free requests reserve nothing")
			}
		})
	}
}

func TestParsePriceConfigRejectsNegativeValues(t *testing.T) {
	tests := []struct {
		name  string
		yaml  string
		field string
	}{
		{name: "group", yaml: "groups: {vip: {ratio: -0.1}}", field: "groups.vip.ratio"},
		{name: "model ratio", yaml: "models: {m: {model_ratio: -1}}", field: "models.m.model_ratio"},
		{name: "completion", yaml: "models: {m: {completion_ratio: -1}}", field: "models.m.completion_ratio"},
		{name: "model price", yaml: "models: {m: {model_price: -0.01}}", field: "models.m.model_price"},
		{name: "defaults", yaml: "defaults: {cache_ratio: -1}", field: "defaults.cache_ratio"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParsePriceConfig([]byte(tt.yaml))
			require.ErrorContains(t, err, tt.field)
		})
	}
}
