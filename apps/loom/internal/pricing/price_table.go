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

// ErrGroupNotPriced 账户分组未在 pricing.yaml 的 groups 中定义且 unknown_group 为 deny。
var ErrGroupNotPriced = errors.New("pricing: group not priced")

const (
	defaultReloadInterval = 30 * time.Second
	fallbackCacheSize     = 10_000
	fallbackMissTTL       = 5 * time.Second
)

// PriceStore 是兜底定价所需的持久化能力（只读 model_pricing 表）。
type PriceStore interface {
	GetModelPrice(ctx context.Context, model string) (store.ModelPrice, error)
	ListModelPricing(ctx context.Context) ([]store.ModelPrice, error)
}

// Options 构造 PriceTable 的参数。
type Options struct {
	File                    string          // pricing.yaml 路径（ConfigMap 挂载点）
	ReloadInterval          time.Duration   // 文件热加载周期，也是 PG 兜底正缓存的 TTL
	DatabaseFallbackEnabled bool            // 是否查 PG model_pricing
	Reserve                 ReserveEstimate // 全局预扣估值
}

// PriceTable 是运行时价目表：pricing.yaml 热加载 + PG 兜底 + 缓存。
type PriceTable struct {
	opts    Options
	store   PriceStore
	metrics *telemetry.Metrics
	log     *slog.Logger

	mu           sync.RWMutex
	priceConfig  *PriceConfig
	checksum     string
	fallbackHits *lru.LRU[string, store.ModelPrice] // PG 兜底命中
	fallbackMiss *lru.LRU[string, struct{}]         // PG 兜底未命中（负缓存）

	stop     chan struct{}
	stopOnce sync.Once
}

// New 创建价目表并同步加载一次 pricing.yaml；加载失败返回错误。
func New(opts Options, storage PriceStore, metrics *telemetry.Metrics, log *slog.Logger) (*PriceTable, error) {
	if opts.ReloadInterval <= 0 {
		opts.ReloadInterval = defaultReloadInterval
	}
	t := &PriceTable{opts: opts, store: storage, metrics: metrics, log: log, stop: make(chan struct{})}
	if _, err := t.Reload(); err != nil {
		return nil, err
	}
	return t, nil
}

// Run 周期热加载 pricing.yaml，阻塞直到 ctx 结束或 Close。
func (t *PriceTable) Run(ctx context.Context) {
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
func (t *PriceTable) Close() { t.stopOnce.Do(func() { close(t.stop) }) }

// Reload 重新读取 pricing.yaml；内容未变化时返回 changed=false。
func (t *PriceTable) Reload() (changed bool, err error) {
	raw, err := os.ReadFile(t.opts.File)
	if err != nil {
		t.metrics.PricingReload.WithLabelValues("error").Inc()
		return false, fmt.Errorf("read pricing file: %w", err)
	}
	priceConfig, err := ParsePriceConfig(raw)
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
	t.priceConfig, t.checksum = priceConfig, checksum
	t.resetFallbackCacheLocked()
	t.metrics.PricingReload.WithLabelValues("ok").Inc()
	t.metrics.PricingModels.Set(float64(len(priceConfig.Models)))
	return true, nil
}

// PriceConfig 返回当前生效的 pricing.yaml。
func (t *PriceTable) PriceConfig() *PriceConfig {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.priceConfig
}

// Lookup 查找单价卡：先按 unknown_group 校验分组，再依次查 pricing.yaml → PG 兜底 → unknown_model 策略。
func (t *PriceTable) Lookup(ctx context.Context, model, group string) (UnitPrice, error) {
	if model == "" {
		return UnitPrice{}, ErrNotPriced
	}
	priceConfig := t.PriceConfig()
	if err := priceConfig.ValidateGroup(group); err != nil {
		t.metrics.PricingLookups.WithLabelValues("group_miss").Inc()
		return UnitPrice{}, err
	}
	modelRate, source, err := t.resolveModelRate(ctx, priceConfig, model)
	if err != nil {
		return UnitPrice{}, err
	}
	if source == "" {
		t.metrics.PricingLookups.WithLabelValues("miss").Inc()
		return UnitPrice{}, ErrNotPriced
	}

	t.metrics.PricingLookups.WithLabelValues(string(source)).Inc()
	return newUnitPrice(unitPriceInput{
		model:      model,
		group:      group,
		groupRatio: priceConfig.GroupRatio(group),
		rate:       modelRate,
		reserve:    t.opts.Reserve,
		source:     source,
	}), nil
}

// resolveModelRate 依次查 pricing.yaml、PG 兜底、unknown_model 策略；
// 三者都没有时 source 为空。
func (t *PriceTable) resolveModelRate(
	ctx context.Context,
	priceConfig *PriceConfig,
	model string,
) (ModelRate, PriceSource, error) {
	if m, ok := priceConfig.Models[model]; ok {
		return m, SourceConfigMap, nil
	}
	if t.opts.DatabaseFallbackEnabled && t.store != nil {
		row, ok, err := t.lookupDatabase(ctx, model)
		if err != nil {
			return ModelRate{}, "", err
		}
		if ok {
			modelRate, err := modelRateFromDatabase(row)
			if err != nil {
				return ModelRate{}, "", err
			}
			return modelRate, SourceDatabase, nil
		}
	}
	if priceConfig.Defaults.UnknownModel == UnknownDefault {
		return priceConfig.defaultModelRate(), SourceDefault, nil
	}
	return ModelRate{}, "", nil
}

// InvalidateFallbackCache 清除 PG 兜底缓存；model 为空时清空全部（管理 API 改价后调用）。
func (t *PriceTable) InvalidateFallbackCache(model string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if model == "" {
		t.resetFallbackCacheLocked()
		return
	}
	t.fallbackHits.Remove(model)
	t.fallbackMiss.Remove(model)
}

func (t *PriceTable) lookupDatabase(ctx context.Context, model string) (store.ModelPrice, bool, error) {
	t.mu.RLock()
	hits, miss := t.fallbackHits, t.fallbackMiss
	t.mu.RUnlock()

	if row, ok := hits.Get(model); ok {
		t.metrics.CacheLookups.WithLabelValues("pricing_store", "hit").Inc()
		return row, true, nil
	}
	if _, ok := miss.Get(model); ok {
		return store.ModelPrice{}, false, nil
	}
	t.metrics.CacheLookups.WithLabelValues("pricing_store", "miss").Inc()

	row, err := t.store.GetModelPrice(ctx, model)
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

// resetFallbackCacheLocked 重建 PG 兜底缓存；调用方需持有写锁。
func (t *PriceTable) resetFallbackCacheLocked() {
	t.fallbackHits = lru.NewLRU[string, store.ModelPrice](fallbackCacheSize, nil, t.opts.ReloadInterval)
	t.fallbackMiss = lru.NewLRU[string, struct{}](fallbackCacheSize, nil, fallbackMissTTL)
}

// modelRateFromDatabase 把 PG 兜底行转换为 ModelRate；预扣字段缺省时用 -1 表示沿用全局值。
// 表中的倍率都是显式值（列默认 1），0 表示免费；负数说明数据被绕过校验写入，直接报错。
func modelRateFromDatabase(row store.ModelPrice) (ModelRate, error) {
	if err := ValidateModelPrice(row); err != nil {
		return ModelRate{}, fmt.Errorf("model_pricing %q: %w", row.Model, err)
	}
	modelRate := ModelRate{
		ModelRatio:      row.ModelRatio,
		CompletionRatio: row.CompletionRatio,
		CacheRatio:      row.CacheRatio,
		ModelPrice:      row.ModelPrice,
	}
	if row.ReserveInputTokens == nil && row.ReserveOutputTokens == nil {
		return modelRate, nil
	}
	reserve := &ReserveEstimate{Input: -1, Output: -1}
	if row.ReserveInputTokens != nil {
		reserve.Input = int64(*row.ReserveInputTokens)
	}
	if row.ReserveOutputTokens != nil {
		reserve.Output = int64(*row.ReserveOutputTokens)
	}
	modelRate.Reserve = reserve
	return modelRate, nil
}

// ValidateModelPrice 校验兜底定价行：倍率与按次单价都不能为负。
func ValidateModelPrice(p store.ModelPrice) error {
	var errs []error
	for field, v := range map[string]float64{
		"model_ratio":      p.ModelRatio,
		"completion_ratio": p.CompletionRatio,
		"cache_ratio":      p.CacheRatio,
	} {
		if v < 0 {
			errs = append(errs, fmt.Errorf("%s must be >= 0, got %v", field, v))
		}
	}
	if p.ModelPrice != nil && *p.ModelPrice < 0 {
		errs = append(errs, fmt.Errorf("model_price must be >= 0, got %v", *p.ModelPrice))
	}
	return errors.Join(errs...)
}
