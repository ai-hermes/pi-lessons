package pricing

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const example = `
defaults:
  model_ratio: 1
  completion_ratio: 1
  cache_ratio: 1
  unknown_model: deny
groups:
  default: {ratio: 1}
  vip: {ratio: 0.9}
models:
  doubao-seed-2.1-lite:    {model_ratio: 0.15, completion_ratio: 2, cache_ratio: 0.1}
  doubao-seedream-5.0-pro: {model_price: 0.04}
`

func TestCostMatchesOneAPIFormula(t *testing.T) {
	spec, err := ParseSpec([]byte(example))
	require.NoError(t, err)
	card := BuildCard("doubao-seed-2.1-lite", "default", spec.GroupRatio("default"), spec.Models["doubao-seed-2.1-lite"],
		spec.Defaults, ReserveTokens{Input: 1024, Output: 1024}, "configmap")
	assert.False(t, card.PerCall())
	// ratio 0.15 × 2000 = 300 nano-USD / input token；cache 0.1 → 30；completion 2 → 600
	assert.Equal(t, int64(300), card.InputNanos)
	assert.Equal(t, int64(30), card.CacheNanos)
	assert.Equal(t, int64(600), card.OutputNanos)
	// (1000-200)×300 + 200×30 + 500×600 = 240000 + 6000 + 300000 = 546000
	assert.Equal(t, int64(546000), card.Cost(1000, 500, 200))
	// 预扣 = 1024×300 + 1024×600
	assert.Equal(t, int64(921600), card.ReserveNanos)
}

func TestCostExampleFromPlan(t *testing.T) {
	// 计划文档 3.2 节示例：ratio 0.5 / completion 2 / cache 0.1 / group 1 → 1,820,000
	d := Defaults{ModelRatio: 1, CompletionRatio: 1, CacheRatio: 1, UnknownModel: UnknownDeny}
	card := BuildCard("m", "default", 1, ModelSpec{ModelRatio: 0.5, CompletionRatio: 2, CacheRatio: 0.1}, d, ReserveTokens{1024, 1024}, "x")
	assert.Equal(t, int64(1000), card.InputNanos)
	assert.Equal(t, int64(100), card.CacheNanos)
	assert.Equal(t, int64(2000), card.OutputNanos)
	assert.Equal(t, int64(1_820_000), card.Cost(1000, 500, 200))
}

func TestPerCallPrice(t *testing.T) {
	spec, err := ParseSpec([]byte(example))
	require.NoError(t, err)
	card := BuildCard("doubao-seedream-5.0-pro", "default", spec.GroupRatio("default"), spec.Models["doubao-seedream-5.0-pro"], spec.Defaults, ReserveTokens{}, "x")
	assert.True(t, card.PerCall())
	assert.Equal(t, int64(40_000_000), card.Cost(0, 0, 0))
	assert.Equal(t, int64(40_000_000), card.ReserveNanos)
	vip := BuildCard("doubao-seedream-5.0-pro", "vip", spec.GroupRatio("vip"), spec.Models["doubao-seedream-5.0-pro"], spec.Defaults, ReserveTokens{}, "x")
	assert.Equal(t, int64(36_000_000), vip.Cost(0, 0, 0))
}

func TestDefaultsApplied(t *testing.T) {
	spec, err := ParseSpec([]byte("models:\n  a: {}\n"))
	require.NoError(t, err)
	assert.Equal(t, float64(1), spec.Defaults.ModelRatio)
	assert.Equal(t, UnknownDeny, spec.Defaults.UnknownModel)
	assert.Equal(t, float64(1), spec.GroupRatio("default"))
	card := BuildCard("a", "default", 1, spec.Models["a"], spec.Defaults, ReserveTokens{1, 1}, "x")
	assert.Equal(t, int64(2000), card.InputNanos)
}

func TestCatalogRender(t *testing.T) {
	spec, err := ParseSpec([]byte(example))
	require.NoError(t, err)
	c := RenderCatalog(spec)
	providers := c["providers"].(map[string]any)
	models := providers["openai"].(map[string]any)["models"].(map[string]any)
	lite := models["doubao-seed-2.1-lite"].(map[string]any)["rates"].(map[string]string)
	assert.Equal(t, "0.3", lite["input"])  // 0.15 × 2 USD / 1M
	assert.Equal(t, "0.6", lite["output"]) // × completion 2
	assert.Equal(t, "0.03", lite["cacheRead"])
	_, hasPerCall := models["doubao-seedream-5.0-pro"]
	assert.False(t, hasPerCall, "per-call models are not expressible in the gateway catalog")
}
