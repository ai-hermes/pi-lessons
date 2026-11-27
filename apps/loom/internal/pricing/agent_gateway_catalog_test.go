package pricing

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRenderAgentGatewayCatalog(t *testing.T) {
	priceConfig, err := ParsePriceConfig([]byte(examplePricing))
	require.NoError(t, err)

	models := RenderAgentGatewayCatalog(priceConfig).Providers["openai"].Models

	expected := AgentGatewayRates{Input: "0.3", Output: "0.6", CacheRead: "0.03"}
	assert.Equal(t, expected, models["doubao-seed-2.1-lite"].Rates)
	assert.NotContains(t, models, "doubao-seedream-5.0-pro", "per-call models are skipped")
}

func TestFormatUSDRemovesFloatNoise(t *testing.T) {
	assert.Equal(t, "0.28", formatUSD(0.14*2))
}
