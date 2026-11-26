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

func cardFor(t *testing.T, spec *Spec, model, group string, reserve ReserveTokens) Card {
	t.Helper()
	m, ok := spec.Models[model]
	require.True(t, ok, "model %q not in spec", model)
	return newCard(cardInput{
		model:      model,
		group:      group,
		groupRatio: spec.GroupRatio(group),
		spec:       m.withDefaults(spec.Defaults),
		reserve:    reserve,
		source:     SourceConfigMap,
	})
}

func TestCardCostFollowsOneAPIFormula(t *testing.T) {
	spec, err := ParseSpec([]byte(examplePricing))
	require.NoError(t, err)

	card := cardFor(t, spec, "doubao-seed-2.1-lite", "default", ReserveTokens{Input: 1024, Output: 1024})

	assert.False(t, card.IsPerCall())
	assert.Equal(t, int64(300), card.InputNanos, "0.15 × 2000")
	assert.Equal(t, int64(30), card.CachedNanos, "× cache_ratio 0.1")
	assert.Equal(t, int64(600), card.OutputNanos, "× completion_ratio 2")
	assert.Equal(t, int64(546_000), card.Cost(Tokens{Input: 1000, Cached: 200, Output: 500}))
	assert.Equal(t, int64(921_600), card.ReserveNanos, "1024 × 300 + 1024 × 600")
}

func TestCardCostPlanExample(t *testing.T) {
	card := newCard(cardInput{
		model:      "m",
		groupRatio: 1,
		spec:       ModelSpec{ModelRatio: 0.5, CompletionRatio: 2, CacheRatio: 0.1},
		reserve:    ReserveTokens{Input: 1024, Output: 1024},
	})

	assert.Equal(t, int64(1000), card.InputNanos)
	assert.Equal(t, int64(100), card.CachedNanos)
	assert.Equal(t, int64(2000), card.OutputNanos)
	assert.Equal(t, int64(1_820_000), card.Cost(Tokens{Input: 1000, Cached: 200, Output: 500}))
}

func TestCardPerCall(t *testing.T) {
	spec, err := ParseSpec([]byte(examplePricing))
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
			card := cardFor(t, spec, "doubao-seedream-5.0-pro", tt.group, ReserveTokens{})
			assert.True(t, card.IsPerCall())
			assert.Equal(t, tt.expected, card.Cost(Tokens{}))
			assert.Equal(t, tt.expected, card.ReserveNanos)
		})
	}
}

func TestCardCachedNeverExceedsInput(t *testing.T) {
	card := Card{InputNanos: 10, CachedNanos: 1, OutputNanos: 20}
	assert.Equal(t, int64(5*1+2*20), card.Cost(Tokens{Input: 5, Cached: 9, Output: 2}))
}

func TestParseSpecDefaults(t *testing.T) {
	spec, err := ParseSpec([]byte("models:\n  a: {}\n"))
	require.NoError(t, err)

	assert.Equal(t, 1.0, spec.Defaults.ModelRatio)
	assert.Equal(t, UnknownModelDeny, spec.Defaults.UnknownModel)
	assert.Equal(t, 1.0, spec.GroupRatio("default"))
	assert.Equal(t, int64(2000), cardFor(t, spec, "a", "default", ReserveTokens{}).InputNanos)
}

func TestParseSpecRejectsUnknownPolicy(t *testing.T) {
	_, err := ParseSpec([]byte("defaults: {unknown_model: allow}\n"))
	assert.Error(t, err)
}

func TestEffectiveReserveOverride(t *testing.T) {
	global := ReserveTokens{Input: 1024, Output: 1024}
	assert.Equal(t, global, effectiveReserve(global, nil))
	assert.Equal(
		t,
		ReserveTokens{Input: 1024, Output: 8},
		effectiveReserve(global, &ReserveTokens{Input: -1, Output: 8}),
	)
}
