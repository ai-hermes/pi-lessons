package admission

import (
	"time"

	"github.com/google/uuid"
	lru "github.com/hashicorp/golang-lru/v2/expirable"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// KeyCacheOptions Key 查找缓存参数。
type KeyCacheOptions struct {
	Enabled     bool
	Size        int
	TTL         time.Duration // 命中缓存；停用 Key 最迟 TTL 后在本副本生效
	NegativeTTL time.Duration // 未知 Key 的负缓存
}

// keyCache 以 Key 摘要为键缓存查找结果；禁用时所有操作为空操作。
type keyCache struct {
	hits *lru.LRU[string, store.Key]
	miss *lru.LRU[string, struct{}]
}

func newKeyCache(opts KeyCacheOptions) *keyCache {
	if !opts.Enabled || opts.Size <= 0 {
		return &keyCache{}
	}
	return &keyCache{
		hits: lru.NewLRU[string, store.Key](opts.Size, nil, atLeastSecond(opts.TTL, 30*time.Second)),
		miss: lru.NewLRU[string, struct{}](opts.Size, nil, atLeastSecond(opts.NegativeTTL, 5*time.Second)),
	}
}

// get 返回缓存结果：ok=false 表示未缓存；负缓存命中时返回 store.ErrNotFound。
func (c *keyCache) get(hash string) (store.Key, error, bool) {
	if c.hits == nil {
		return store.Key{}, nil, false
	}
	if key, ok := c.hits.Get(hash); ok {
		return key, nil, true
	}
	if _, ok := c.miss.Get(hash); ok {
		return store.Key{}, store.ErrNotFound, true
	}
	return store.Key{}, nil, false
}

func (c *keyCache) add(hash string, key store.Key) {
	if c.hits != nil {
		c.hits.Add(hash, key)
	}
}

func (c *keyCache) addMiss(hash string) {
	if c.miss != nil {
		c.miss.Add(hash, struct{}{})
	}
}

func (c *keyCache) invalidate(keyID uuid.UUID) {
	if c.hits == nil {
		return
	}
	for _, hash := range c.hits.Keys() {
		if key, ok := c.hits.Peek(hash); ok && key.ID == keyID {
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
