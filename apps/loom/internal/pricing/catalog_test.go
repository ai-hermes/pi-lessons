package pricing

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRenderGatewayCatalog(t *testing.T) {
	spec, err := ParseSpec([]byte(examplePricing))
	require.NoError(t, err)

	models := RenderGatewayCatalog(spec).Providers["openai"].Models

	assert.Equal(t, GatewayRates{Input: "0.3", Output: "0.6", CacheRead: "0.03"}, models["doubao-seed-2.1-lite"].Rates)
	assert.NotContains(
		t,
		models,
		"doubao-seedream-5.0-pro",
		"per-call models are not expressible in the gateway catalog",
	)
}

func TestFormatUSDRemovesFloatNoise(t *testing.T) {
	assert.Equal(t, "0.28", formatUSD(0.14*2))
}
