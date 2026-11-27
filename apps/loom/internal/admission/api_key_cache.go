package admission

import (
	"time"

	"github.com/google/uuid"
	lru "github.com/hashicorp/golang-lru/v2/expirable"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// APIKeyCacheOptions Key 查找缓存参数。
type APIKeyCacheOptions struct {
	Enabled     bool
	Size        int
	TTL         time.Duration // 命中缓存；停用 Key 最迟 TTL 后在本副本生效
	NegativeTTL time.Duration // 未知 Key 的负缓存
}

// apiKeyCache 以 Key 摘要为键缓存查找结果；禁用时所有操作为空操作。
type apiKeyCache struct {
	hits *lru.LRU[string, store.APIKey]
	miss *lru.LRU[string, struct{}]
}

func newAPIKeyCache(opts APIKeyCacheOptions) *apiKeyCache {
	if !opts.Enabled || opts.Size <= 0 {
		return &apiKeyCache{}
	}
	hitTTL := atLeastSecond(opts.TTL, 30*time.Second)
	missTTL := atLeastSecond(opts.NegativeTTL, 5*time.Second)
	return &apiKeyCache{
		hits: lru.NewLRU[string, store.APIKey](opts.Size, nil, hitTTL),
		miss: lru.NewLRU[string, struct{}](opts.Size, nil, missTTL),
	}
}

// get 返回缓存结果：ok=false 表示未缓存；负缓存命中时返回 store.ErrNotFound。
func (c *apiKeyCache) get(hash string) (store.APIKey, error, bool) {
	if c.hits == nil {
		return store.APIKey{}, nil, false
	}
	if apiKey, ok := c.hits.Get(hash); ok {
		return apiKey, nil, true
	}
	if _, ok := c.miss.Get(hash); ok {
		return store.APIKey{}, store.ErrNotFound, true
	}
	return store.APIKey{}, nil, false
}

func (c *apiKeyCache) add(hash string, apiKey store.APIKey) {
	if c.hits != nil {
		c.hits.Add(hash, apiKey)
	}
}

func (c *apiKeyCache) addMiss(hash string) {
	if c.miss != nil {
		c.miss.Add(hash, struct{}{})
	}
}

func (c *apiKeyCache) invalidate(apiKeyID uuid.UUID) {
	c.removeWhere(func(apiKey store.APIKey) bool { return apiKey.ID == apiKeyID })
}

// invalidateAccount 删除该账户下所有 API Key 的缓存（缓存里带着账户状态与分组的快照）。
func (c *apiKeyCache) invalidateAccount(accountID uuid.UUID) {
	c.removeWhere(func(apiKey store.APIKey) bool { return apiKey.AccountID == accountID })
}

func (c *apiKeyCache) removeWhere(match func(store.APIKey) bool) {
	if c.hits == nil {
		return
	}
	for _, hash := range c.hits.Keys() {
		if apiKey, ok := c.hits.Peek(hash); ok && match(apiKey) {
			c.hits.Remove(hash)
		}
	}
}

// atLeastSecond 返回不小于 1s 的 TTL（expirable LRU 按 TTL 分桶，过小会 panic）。
func atLeastSecond(ttl, fallback time.Duration) time.Duration {
	if ttl < time.Second {
		return fallback
	}
	return ttl
}
