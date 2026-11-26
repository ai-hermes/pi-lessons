package pricing

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2/expirable"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// ErrNotPriced 模型没有定价且 unknown_model 为 deny。
var ErrNotPriced = errors.New("pricing: model not priced")

const (
	defaultReloadInterval = 30 * time.Second
	storeCacheSize        = 10_000
	storeMissTTL          = 5 * time.Second
)

// Store 是兜底定价所需的持久化能力。
type Store interface {
	GetModelPricing(ctx context.Context, model string) (store.ModelPrice, error)
	ListModelPricing(ctx context.Context) ([]store.ModelPrice, error)
}

// Options 构造 Table 的参数。
type Options struct {
	File           string        // pricing.yaml 路径（ConfigMap 挂载点）
	ReloadInterval time.Duration // 文件热加载周期，也是 PG 兜底正缓存的 TTL
	StoreFallback  bool          // 是否查 PG model_pricing
	Reserve        ReserveTokens // 全局预扣估值
}

// Table 是运行时价目表：pricing.yaml 热加载 + PG 兜底 + 缓存。
type Table struct {
	opts    Options
	store   Store
	metrics *telemetry.Metrics
	log     *slog.Logger

	mu        sync.RWMutex
	spec      *Spec
	checksum  string
	storeHits *lru.LRU[string, store.ModelPrice] // PG 兜底命中
	storeMiss *lru.LRU[string, struct{}]         // PG 兜底未命中（负缓存）

	stop     chan struct{}
	stopOnce sync.Once
}

// New 创建价目表并同步加载一次 pricing.yaml；加载失败返回错误。
func New(opts Options, st Store, metrics *telemetry.Metrics, log *slog.Logger) (*Table, error) {
	if opts.ReloadInterval <= 0 {
		opts.ReloadInterval = defaultReloadInterval
	}
	t := &Table{opts: opts, store: st, metrics: metrics, log: log, stop: make(chan struct{})}
	if _, err := t.Reload(); err != nil {
		return nil, err
	}
	return t, nil
}

// Run 周期热加载 pricing.yaml，阻塞直到 ctx 结束或 Close。
func (t *Table) Run(ctx context.Context) {
	ticker := time.NewTicker(t.opts.ReloadInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.stop:
			return
		case <-ticker.C:
			changed, err := t.Reload()
			if err != nil {
				t.log.Warn("pricing reload failed", "err", err)
				continue
			}
			if changed {
				t.log.Info("pricing reloaded")
			}
		}
	}
}

// Close 停止热加载。
func (t *Table) Close() { t.stopOnce.Do(func() { close(t.stop) }) }

// Reload 重新读取 pricing.yaml；内容未变化时返回 changed=false。
func (t *Table) Reload() (changed bool, err error) {
	raw, err := os.ReadFile(t.opts.File)
	if err != nil {
		t.metrics.PricingReload.WithLabelValues("error").Inc()
		return false, fmt.Errorf("read pricing file: %w", err)
	}
	spec, err := ParseSpec(raw)
	if err != nil {
		t.metrics.PricingReload.WithLabelValues("error").Inc()
		return false, err
	}
	checksum := fmt.Sprintf("%x", sha256.Sum256(raw))

	t.mu.Lock()
	defer t.mu.Unlock()
	if checksum == t.checksum {
		return false, nil
	}
	t.spec, t.checksum = spec, checksum
	t.resetStoreCacheLocked()
	t.metrics.PricingReload.WithLabelValues("ok").Inc()
	t.metrics.PricingModels.Set(float64(len(spec.Models)))
	return true, nil
}

// Spec 返回当前生效的 pricing.yaml。
func (t *Table) Spec() *Spec {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.spec
}

// Lookup 查找单价卡：pricing.yaml → PG 兜底 → unknown_model 策略。
func (t *Table) Lookup(ctx context.Context, model, group string) (Card, error) {
	if model == "" {
		return Card{}, ErrNotPriced
	}
	spec := t.Spec()
	in := cardInput{model: model, group: group, groupRatio: spec.GroupRatio(group), reserve: t.opts.Reserve}

	if m, ok := spec.Models[model]; ok {
		in.spec, in.source = m.withDefaults(spec.Defaults), SourceConfigMap
		return t.found(in), nil
	}
	if t.opts.StoreFallback && t.store != nil {
		row, ok, err := t.lookupStore(ctx, model)
		if err != nil {
			return Card{}, err
		}
		if ok {
			in.spec, in.source = modelSpecFromStore(row).withDefaults(spec.Defaults), SourceStore
			return t.found(in), nil
		}
	}
	if spec.Defaults.UnknownModel == UnknownModelDefault {
		in.spec, in.source = ModelSpec{}.withDefaults(spec.Defaults), SourceDefault
		return t.found(in), nil
	}
	t.metrics.PricingLookups.WithLabelValues("miss").Inc()
	return Card{}, ErrNotPriced
}

func (t *Table) found(in cardInput) Card {
	t.metrics.PricingLookups.WithLabelValues(string(in.source)).Inc()
	return newCard(in)
}

// InvalidateStoreCache 清除 PG 兜底缓存；model 为空时清空全部（管理 API 改价后调用）。
func (t *Table) InvalidateStoreCache(model string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if model == "" {
		t.resetStoreCacheLocked()
		return
	}
	t.storeHits.Remove(model)
	t.storeMiss.Remove(model)
}

func (t *Table) lookupStore(ctx context.Context, model string) (store.ModelPrice, bool, error) {
	t.mu.RLock()
	hits, miss := t.storeHits, t.storeMiss
	t.mu.RUnlock()

	if row, ok := hits.Get(model); ok {
		t.metrics.CacheLookups.WithLabelValues("pricing_store", "hit").Inc()
		return row, true, nil
	}
	if _, ok := miss.Get(model); ok {
		return store.ModelPrice{}, false, nil
	}
	t.metrics.CacheLookups.WithLabelValues("pricing_store", "miss").Inc()

	row, err := t.store.GetModelPricing(ctx, model)
	switch {
	case errors.Is(err, store.ErrNotFound):
		miss.Add(model, struct{}{})
		return store.ModelPrice{}, false, nil
	case err != nil:
		return store.ModelPrice{}, false, fmt.Errorf("get model pricing %q: %w", model, err)
	}
	hits.Add(model, row)
	return row, true, nil
}

// resetStoreCacheLocked 重建 PG 兜底缓存；调用方需持有写锁。
func (t *Table) resetStoreCacheLocked() {
	t.storeHits = lru.NewLRU[string, store.ModelPrice](storeCacheSize, nil, t.opts.ReloadInterval)
	t.storeMiss = lru.NewLRU[string, struct{}](storeCacheSize, nil, storeMissTTL)
}

// modelSpecFromStore 把 PG 兜底行转换为 ModelSpec；预扣字段缺省时用 -1 表示沿用全局值。
func modelSpecFromStore(row store.ModelPrice) ModelSpec {
	spec := ModelSpec{
		ModelRatio:      row.ModelRatio,
		CompletionRatio: row.CompletionRatio,
		CacheRatio:      row.CacheRatio,
		ModelPrice:      row.ModelPrice,
	}
	if row.ReserveInputTokens == nil && row.ReserveOutputTokens == nil {
		return spec
	}
	reserve := &ReserveTokens{Input: -1, Output: -1}
	if row.ReserveInputTokens != nil {
		reserve.Input = int64(*row.ReserveInputTokens)
	}
	if row.ReserveOutputTokens != nil {
		reserve.Output = int64(*row.ReserveOutputTokens)
	}
	spec.ReserveTokens = reserve
	return spec
}
