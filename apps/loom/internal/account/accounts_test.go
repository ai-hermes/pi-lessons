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
}

func (c *recordingCache) InvalidateAPIKey(id uuid.UUID)  { c.apiKeys = append(c.apiKeys, id) }
func (c *recordingCache) InvalidateAccount(id uuid.UUID) { c.accounts = append(c.accounts, id) }

func newService(t *testing.T, pricingYAML string, caches ...CacheInvalidator) *Service {
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
	return New(st, prices, "", caches...)
}

const groupsPricing = "groups:\n  vip: {ratio: 0.9}\n"

func TestCreateAccountRejectsUndefinedGroup(t *testing.T) {
	s := newService(t, groupsPricing)

	_, err := s.CreateAccount(context.Background(), CreateAccountInput{Name: "a", Group: "VIP"})
	require.ErrorIs(t, err, ErrInvalidInput)
	require.ErrorIs(t, err, pricing.ErrGroupNotPriced)

	account, err := s.CreateAccount(context.Background(), CreateAccountInput{Name: "b"})
	require.NoError(t, err)
	assert.Equal(t, pricing.DefaultGroup, account.Group, "default group is implicit")
}

func TestCreateAccountAllowsUndefinedGroupWhenPolicyIsDefault(t *testing.T) {
	s := newService(t, "defaults: {unknown_group: default}\n"+groupsPricing)

	_, err := s.CreateAccount(context.Background(), CreateAccountInput{Name: "a", Group: "enterprise"})

	require.NoError(t, err)
}

func TestUpdateAccountValidatesGroupAndInvalidatesCaches(t *testing.T) {
	cache := &recordingCache{}
	s := newService(t, groupsPricing, cache)
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
