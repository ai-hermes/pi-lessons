package ledger

import (
	"context"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// lab-model 的 1000/200/500 tokens：default 分组 1,820,000，vip 0.9 → 1,638,000。
const (
	defaultGroupCost = int64(1_820_000)
	vipGroupCost     = int64(1_638_000)
)

func (f *fixture) setGroup(t *testing.T, group string) {
	t.Helper()
	account, err := f.st.GetAccount(context.Background(), f.apiKey.AccountID)
	require.NoError(t, err)
	settings := account.Settings()
	settings.Group = group
	_, err = f.st.UpdateAccount(context.Background(), account.ID, settings)
	require.NoError(t, err)
}

func (f *fixture) lastUsageEvent(t *testing.T) store.UsageEvent {
	t.Helper()
	events, err := f.st.ListUsage(context.Background(), nil, nil, 1)
	require.NoError(t, err)
	require.Len(t, events, 1)
	return events[0]
}

func (f *fixture) settle(t *testing.T, report UsageReport) {
	t.Helper()
	inserted, err := f.ledger.Settle(context.Background(), report)
	require.NoError(t, err)
	require.True(t, inserted)
}

func TestSettleRecordsPricingSnapshot(t *testing.T) {
	f := newFixture(t)
	f.setGroup(t, "vip")

	f.settle(t, f.usageReport("req-1"))

	event := f.lastUsageEvent(t)
	assert.Equal(t, vipGroupCost, event.CostNanos)
	require.NotNil(t, event.Pricing)
	assert.Equal(t, "vip", event.Pricing.Group)
	assert.InDelta(t, 0.9, event.Pricing.GroupRatio, 1e-9)
	assert.InDelta(t, 0.5, event.Pricing.ModelRatio, 1e-9)
	assert.InDelta(t, 2.0, event.Pricing.CompletionRatio, 1e-9)
	assert.InDelta(t, 0.1, event.Pricing.CacheRatio, 1e-9)
	assert.Nil(t, event.Pricing.ModelPrice)
}

func TestSettleAgentGatewayPreferredAppliesGroupRatio(t *testing.T) {
	f := newFixtureWith(t, Options{CostSource: CostSourceAgentGatewayPreferred})
	f.setGroup(t, "vip")
	report := f.usageReport("req-1")
	agentGatewayCost := defaultGroupCost // 网关 catalog 是 1 倍价
	report.AgentGatewayCostNanos = &agentGatewayCost

	f.settle(t, report)

	event := f.lastUsageEvent(t)
	assert.Equal(t, vipGroupCost, event.CostNanos, "gateway cost × group ratio, not the raw gateway cost")
	assert.Equal(t, "gateway", event.PricingSource)
}

func TestReconcileComparesAgentGatewayCostWithGroupRatio(t *testing.T) {
	tests := []struct {
		name             string
		agentGatewayCost int64
		expectedMismatch float64
	}{
		{name: "matching after group ratio", agentGatewayCost: defaultGroupCost, expectedMismatch: 0},
		{name: "real mismatch", agentGatewayCost: 2_000_000, expectedMismatch: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			f.setGroup(t, "vip")
			report := f.usageReport("req-1")
			report.AgentGatewayCostNanos = &tt.agentGatewayCost

			f.settle(t, report)

			assert.Equal(t, vipGroupCost, f.lastUsageEvent(t).CostNanos, "loom pricing still wins")
			mismatches := testutil.ToFloat64(f.metrics.CostMismatch.WithLabelValues("lab-model"))
			assert.InDelta(t, tt.expectedMismatch, mismatches, 1e-9)
		})
	}
}

func TestSettleUndefinedGroupFallsBackToDefaultGroup(t *testing.T) {
	f := newFixture(t)
	f.setGroup(t, "removed-from-pricing-yaml")

	f.settle(t, f.usageReport("req-1"))

	event := f.lastUsageEvent(t)
	assert.Equal(t, defaultGroupCost, event.CostNanos, "already-served usage is never settled at 0")
	require.NotNil(t, event.Pricing)
	assert.Equal(t, pricing.DefaultGroup, event.Pricing.Group)
}

func TestInvalidateAccountAppliesGroupChangeImmediately(t *testing.T) {
	f := newFixture(t)
	f.settle(t, f.usageReport("req-1")) // 缓存 default 分组的归属
	f.setGroup(t, "vip")

	f.settle(t, f.usageReport("req-2"))
	assert.Equal(t, defaultGroupCost, f.lastUsageEvent(t).CostNanos, "stale owner cache without invalidation")

	f.ledger.InvalidateAccount(f.apiKey.AccountID)
	f.settle(t, f.usageReport("req-3"))
	assert.Equal(t, vipGroupCost, f.lastUsageEvent(t).CostNanos)
}
