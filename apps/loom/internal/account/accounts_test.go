package account

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/memstore"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// recordingCache 记录收到的失效通知。
type recordingCache struct {
	apiKeys  []uuid.UUID
	accounts []uuid.UUID
	models   []string
}

func (c *recordingCache) InvalidateAPIKey(_ context.Context, id uuid.UUID) {
	c.apiKeys = append(c.apiKeys, id)
}

func (c *recordingCache) InvalidateAccount(_ context.Context, id uuid.UUID) {
	c.accounts = append(c.accounts, id)
}

func (c *recordingCache) InvalidateModelPrice(_ context.Context, model string) {
	c.models = append(c.models, model)
}

func newService(t *testing.T, pricingYAML string) (*Service, *recordingCache) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "pricing.yaml")
	require.NoError(t, os.WriteFile(file, []byte(pricingYAML), 0o600))
	st := memstore.New()
	prices, err := pricing.New(
		pricing.Options{File: file},
		st,
		telemetry.NewMetrics("test", "test"),
		slog.New(slog.DiscardHandler),
	)
	require.NoError(t, err)
	cache := &recordingCache{}
	return New(st, prices, "", cache), cache
}

const groupsPricing = "groups:\n  vip: {ratio: 0.9}\n"

func TestCreateAccountRejectsUndefinedGroup(t *testing.T) {
	s, _ := newService(t, groupsPricing)

	_, err := s.CreateAccount(context.Background(), CreateAccountInput{Name: "a", Group: "VIP"})
	require.ErrorIs(t, err, ErrInvalidInput)
	require.ErrorIs(t, err, pricing.ErrGroupNotPriced)

	account, err := s.CreateAccount(context.Background(), CreateAccountInput{Name: "b"})
	require.NoError(t, err)
	assert.Equal(t, pricing.DefaultGroup, account.Group, "default group is implicit")
}

func TestCreateAccountAllowsUndefinedGroupWhenPolicyIsDefault(t *testing.T) {
	s, _ := newService(t, "defaults: {unknown_group: default}\n"+groupsPricing)

	_, err := s.CreateAccount(context.Background(), CreateAccountInput{Name: "a", Group: "enterprise"})

	require.NoError(t, err)
}

func TestUpdateAccountValidatesGroupAndInvalidatesCaches(t *testing.T) {
	s, cache := newService(t, groupsPricing)
	account, err := s.CreateAccount(context.Background(), CreateAccountInput{Name: "a"})
	require.NoError(t, err)

	_, err = s.UpdateAccount(context.Background(), account.ID, UpdateAccountInput{Group: "ghost"})
	require.ErrorIs(t, err, ErrInvalidInput)
	assert.Empty(t, cache.accounts, "rejected updates do not touch caches")

	updated, err := s.UpdateAccount(context.Background(), account.ID, UpdateAccountInput{Group: "vip"})
	require.NoError(t, err)
	assert.Equal(t, "vip", updated.Group)
	assert.Equal(t, []uuid.UUID{account.ID}, cache.accounts)
}

func TestModelPriceChangesInvalidateFallbackCache(t *testing.T) {
	s, cache := newService(t, groupsPricing)
	ratio := 0.5

	require.NoError(t, s.UpsertModelPrice(context.Background(), "pg-model", ModelPriceInput{ModelRatio: &ratio}))
	require.NoError(t, s.DeleteModelPrice(context.Background(), "pg-model"))

	assert.Equal(t, []string{"pg-model", "pg-model"}, cache.models)
}
