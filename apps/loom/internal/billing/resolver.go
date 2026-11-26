package billing

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	lru "github.com/hashicorp/golang-lru/v2/expirable"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// Resolver 把 access log 里的 key id / client name 解析为账户与分组，带短 TTL 缓存。
type Resolver struct {
	st       store.Store
	byKey    *lru.LRU[string, Owner]
	byName   *lru.LRU[string, Owner]
	fallback *lru.LRU[string, struct{}]
}

// NewResolver 创建解析器。
func NewResolver(st store.Store, ttl time.Duration) *Resolver {
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	return &Resolver{st: st, byKey: lru.NewLRU[string, Owner](10000, nil, ttl),
		byName: lru.NewLRU[string, Owner](10000, nil, ttl), fallback: lru.NewLRU[string, struct{}](10000, nil, 5*time.Second)}
}

// Resolve 优先按 key id，其次按 client name；都没有则返回空归属（未鉴权流量）。
func (r *Resolver) Resolve(ctx context.Context, rec Record) (Owner, error) {
	if rec.KeyID != uuid.Nil {
		k := rec.KeyID.String()
		if o, ok := r.byKey.Get(k); ok {
			return o, nil
		}
		if _, miss := r.fallback.Get("key:" + k); miss {
			return Owner{}, loom.ErrNotFound
		}
		key, err := r.st.GetKey(ctx, rec.KeyID)
		if errors.Is(err, loom.ErrNotFound) {
			r.fallback.Add("key:"+k, struct{}{})
			return Owner{}, err
		}
		if err != nil {
			return Owner{}, err
		}
		o := Owner{AccountID: key.AccountID, KeyID: key.ID, Group: key.Account.Group}
		r.byKey.Add(k, o)
		return o, nil
	}
	if rec.ClientID != "" {
		if o, ok := r.byName.Get(rec.ClientID); ok {
			return o, nil
		}
		if _, miss := r.fallback.Get("name:" + rec.ClientID); miss {
			return Owner{}, loom.ErrNotFound
		}
		a, err := r.st.GetAccountByName(ctx, rec.ClientID)
		if errors.Is(err, loom.ErrNotFound) {
			r.fallback.Add("name:"+rec.ClientID, struct{}{})
			return Owner{}, err
		}
		if err != nil {
			return Owner{}, err
		}
		o := Owner{AccountID: a.ID, Group: a.Group}
		r.byName.Add(rec.ClientID, o)
		return o, nil
	}
	return Owner{}, nil
}
