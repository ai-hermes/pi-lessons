package pricing

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

func newPriceTable(t *testing.T, yaml string) *PriceTable {
	t.Helper()
	file := filepath.Join(t.TempDir(), "pricing.yaml")
	require.NoError(t, os.WriteFile(file, []byte(yaml), 0o600))
	table, err := New(
		Options{File: file},
		nil,
		telemetry.NewMetrics("test", "test"),
		slog.New(slog.DiscardHandler),
	)
	require.NoError(t, err)
	return table
}

func TestDefaultGroupIsAlwaysDefined(t *testing.T) {
	priceConfig, err := ParsePriceConfig([]byte("groups:\n  vip: {ratio: 0.9}\n"))
	require.NoError(t, err)

	assert.True(t, priceConfig.HasGroup(DefaultGroup), "omitting default must not lock out default accounts")
	assert.InDelta(t, DefaultGroupRatio, priceConfig.GroupRatio(DefaultGroup), 1e-9)
}

func TestLookupDeniesUndefinedGroupByDefault(t *testing.T) {
	table := newPriceTable(t, "groups:\n  vip: {ratio: 0.9}\nmodels:\n  m: {model_ratio: 1}\n")

	_, err := table.Lookup(context.Background(), "m", "VIP")

	require.ErrorIs(t, err, ErrGroupNotPriced, "group names are case-sensitive and never silently priced at 1x")
	require.ErrorIs(t, table.PriceConfig().ValidateGroup("vip "), ErrGroupNotPriced)
	require.NoError(t, table.PriceConfig().ValidateGroup("vip"))
}

func TestLookupPricesUndefinedGroupAsDefaultWhenAllowed(t *testing.T) {
	yaml := `
defaults: {unknown_group: default}
groups:
  default: {ratio: 0.8}
models:
  m: {model_ratio: 1}
`
	table := newPriceTable(t, yaml)

	unitPrice, err := table.Lookup(context.Background(), "m", "enterprise")

	require.NoError(t, err)
	assert.InDelta(t, 0.8, unitPrice.GroupRatio, 1e-9, "undefined group uses the default group's ratio")
	require.NoError(t, table.PriceConfig().ValidateGroup("enterprise"))
}

func TestParsePriceConfigRejectsUnknownGroupPolicy(t *testing.T) {
	_, err := ParsePriceConfig([]byte("defaults: {unknown_group: allow}\n"))
	require.ErrorContains(t, err, "defaults.unknown_group")
}

func TestCostRoundsOncePerRequest(t *testing.T) {
	unitPrice := newUnitPrice(unitPriceInput{
		model:      "cheap",
		groupRatio: 0.9,
		rate:       ModelRate{ModelRatio: 0.0375, CompletionRatio: 1, CacheRatio: 0.1},
	})

	assert.InDelta(t, 6.75, unitPrice.CachedNanos, 1e-9, "per-token price keeps its fraction")
	assert.Equal(t, int64(6_750), unitPrice.Cost(TokenUsage{Input: 1000, Cached: 1000}),
		"rounding the per-token price to 7 first would charge 7,000 (+3.7%)")
}
