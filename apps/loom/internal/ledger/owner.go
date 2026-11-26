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
	ownerCacheSize = 10_000
	ownerMissTTL   = 5 * time.Second
)

// owner 是一笔用量的归属：账户、Key 与定价分组。
type owner struct {
	accountID uuid.UUID
	keyID     uuid.UUID
	group     string
}

// ownerCache 把用量上报里的 Key ID / 账户名解析为归属，带短 TTL 缓存与负缓存。
type ownerCache struct {
	store  Store
	byKey  *lru.LRU[uuid.UUID, owner]
	byName *lru.LRU[string, owner]
	miss   *lru.LRU[string, struct{}]
}

func newOwnerCache(st Store, ttl time.Duration) *ownerCache {
	if ttl <= 0 {
		ttl = time.Minute
	}
	return &ownerCache{
		store:  st,
		byKey:  lru.NewLRU[uuid.UUID, owner](ownerCacheSize, nil, ttl),
		byName: lru.NewLRU[string, owner](ownerCacheSize, nil, ttl),
		miss:   lru.NewLRU[string, struct{}](ownerCacheSize, nil, ownerMissTTL),
	}
}

// resolve 优先按 Key ID，其次按账户名；两者都没有时返回空归属（未鉴权流量，只记账不扣额度）。
func (c *ownerCache) resolve(ctx context.Context, u Usage) (owner, error) {
	switch {
	case u.KeyID != uuid.Nil:
		return c.byKeyID(ctx, u.KeyID)
	case u.AccountName != "":
		return c.byAccountName(ctx, u.AccountName)
	default:
		return owner{}, nil
	}
}

func (c *ownerCache) byKeyID(ctx context.Context, id uuid.UUID) (owner, error) {
	if o, ok := c.byKey.Get(id); ok {
		return o, nil
	}
	missKey := "key:" + id.String()
	if _, ok := c.miss.Get(missKey); ok {
		return owner{}, store.ErrNotFound
	}
	key, err := c.store.GetKey(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		c.miss.Add(missKey, struct{}{})
	}
	if err != nil {
		return owner{}, err
	}
	o := owner{accountID: key.AccountID, keyID: key.ID, group: key.Account.Group}
	c.byKey.Add(id, o)
	return o, nil
}

func (c *ownerCache) byAccountName(ctx context.Context, name string) (owner, error) {
	if o, ok := c.byName.Get(name); ok {
		return o, nil
	}
	missKey := "account:" + name
	if _, ok := c.miss.Get(missKey); ok {
		return owner{}, store.ErrNotFound
	}
	account, err := c.store.GetAccountByName(ctx, name)
	if errors.Is(err, store.ErrNotFound) {
		c.miss.Add(missKey, struct{}{})
	}
	if err != nil {
		return owner{}, err
	}
	o := owner{accountID: account.ID, group: account.Group}
	c.byName.Add(name, o)
	return o, nil
}
