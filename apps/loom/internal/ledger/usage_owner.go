package ledger

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	lru "github.com/hashicorp/golang-lru/v2/expirable"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

const (
	usageOwnerCacheSize = 10_000
	usageOwnerMissTTL   = 5 * time.Second
)

// usageOwner 是一笔用量的归属：账户、Key 与定价分组。
type usageOwner struct {
	accountID uuid.UUID
	apiKeyID  uuid.UUID
	group     string
	apiKey    store.APIKey // 按 Key ID 解析时的 Key 快照（含限流配置）；按账户名解析时为零值
}

// usageOwnerCache 把用量上报里的 Key ID / 账户名解析为归属，带短 TTL 缓存与负缓存。
type usageOwnerCache struct {
	store              Store
	byAPIKeyIDCache    *lru.LRU[uuid.UUID, usageOwner]
	byAccountNameCache *lru.LRU[string, usageOwner]
	miss               *lru.LRU[string, struct{}]
}

func newOwnerCache(storage Store, ttl time.Duration) *usageOwnerCache {
	if ttl <= 0 {
		ttl = time.Minute
	}
	return &usageOwnerCache{
		store:              storage,
		byAPIKeyIDCache:    lru.NewLRU[uuid.UUID, usageOwner](usageOwnerCacheSize, nil, ttl),
		byAccountNameCache: lru.NewLRU[string, usageOwner](usageOwnerCacheSize, nil, ttl),
		miss:               lru.NewLRU[string, struct{}](usageOwnerCacheSize, nil, usageOwnerMissTTL),
	}
}

// resolve 优先按 Key ID，其次按账户名；两者都没有时返回空归属（未鉴权流量，只记账不扣额度）。
func (c *usageOwnerCache) resolve(ctx context.Context, report UsageReport) (usageOwner, error) {
	switch {
	case report.APIKeyID != uuid.Nil:
		return c.byAPIKeyID(ctx, report.APIKeyID)
	case report.AccountName != "":
		return c.byAccountName(ctx, report.AccountName)
	default:
		return usageOwner{}, nil
	}
}

func (c *usageOwnerCache) byAPIKeyID(ctx context.Context, id uuid.UUID) (usageOwner, error) {
	if owner, ok := c.byAPIKeyIDCache.Get(id); ok {
		return owner, nil
	}
	missKey := "key:" + id.String()
	if _, ok := c.miss.Get(missKey); ok {
		return usageOwner{}, store.ErrNotFound
	}
	apiKey, err := c.store.GetAPIKey(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		c.miss.Add(missKey, struct{}{})
	}
	if err != nil {
		return usageOwner{}, err
	}
	owner := usageOwner{
		accountID: apiKey.AccountID,
		apiKeyID:  apiKey.ID,
		group:     apiKey.Account.Group,
		apiKey:    apiKey,
	}
	c.byAPIKeyIDCache.Add(id, owner)
	return owner, nil
}

func (c *usageOwnerCache) byAccountName(ctx context.Context, name string) (usageOwner, error) {
	if owner, ok := c.byAccountNameCache.Get(name); ok {
		return owner, nil
	}
	missKey := "account:" + name
	if _, ok := c.miss.Get(missKey); ok {
		return usageOwner{}, store.ErrNotFound
	}
	account, err := c.store.GetAccountByName(ctx, name)
	if errors.Is(err, store.ErrNotFound) {
		c.miss.Add(missKey, struct{}{})
	}
	if err != nil {
		return usageOwner{}, err
	}
	owner := usageOwner{accountID: account.ID, group: account.Group}
	c.byAccountNameCache.Add(name, owner)
	return owner, nil
}

// invalidateAPIKey 删除该 API Key 的归属缓存。
func (c *usageOwnerCache) invalidateAPIKey(apiKeyID uuid.UUID) {
	c.byAPIKeyIDCache.Remove(apiKeyID)
}

// invalidateAccount 删除该账户相关的全部归属缓存（归属里带着账户分组）。
func (c *usageOwnerCache) invalidateAccount(accountID uuid.UUID) {
	for _, apiKeyID := range c.byAPIKeyIDCache.Keys() {
		if owner, ok := c.byAPIKeyIDCache.Peek(apiKeyID); ok && owner.accountID == accountID {
			c.byAPIKeyIDCache.Remove(apiKeyID)
		}
	}
	for _, name := range c.byAccountNameCache.Keys() {
		if owner, ok := c.byAccountNameCache.Peek(name); ok && owner.accountID == accountID {
			c.byAccountNameCache.Remove(name)
		}
	}
}
