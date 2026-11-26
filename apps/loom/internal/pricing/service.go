package pricing

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/cache"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

type empty struct{}

// Service 定价服务：ConfigMap 文件热加载 + PG 兜底 + LRU 缓存。
type Service struct {
	cfg     config.Pricing
	reserve ReserveTokens
	st      store.Store
	m       *telemetry.Metrics
	log     *slog.Logger

	onLoad func(Spec)
	loaded chan struct{}
	done   chan struct{}

	mu    sync.RWMutex
	spec  *Spec
	sum   string
	pgPos *cache.TTLCache[string, store.ModelPrice]
	pgNeg *cache.TTLCache[string, empty]
}

// NewService 创建服务；调用 Load 首次加载。
func NewService(cfg config.Pricing, reserve config.ReserveTokens, st store.Store, m *telemetry.Metrics, log *slog.Logger) *Service {
	return &Service{cfg: cfg, reserve: ReserveTokens{Input: reserve.Input, Output: reserve.Output}, st: st, m: m, log: log,
		done: make(chan struct{}), loaded: make(chan struct{})}
}

// OnLoaded 设置加载成功回调。
func (s *Service) OnLoaded(fn func(Spec)) { s.onLoad = fn }

// Start 启动后台热加载；首次加载失败直接返回错误（启动失败）。
func (s *Service) Start(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	if err := s.Load(ctx); err != nil {
		return err
	}
	close(s.loaded)
	go s.loop(ctx, interval)
	return nil
}

// Stop 结束后台循环。
func (s *Service) Stop() {
	select {
	case <-s.done:
	default:
		close(s.done)
	}
}

func (s *Service) loop(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.done:
			return
		case <-t.C:
			if _, changed, err := s.Reload(ctx); err != nil {
				s.log.Warn("pricing reload failed", "err", err)
			} else if changed {
				s.log.Info("pricing reloaded")
			}
		}
	}
}

// Load 读取文件并重建索引。
func (s *Service) Load(ctx context.Context) error {
	_, _, err := s.Reload(ctx)
	return err
}

// Reload 重新读取文件；返回是否发生变化。
func (s *Service) Reload(ctx context.Context) (bool, bool, error) {
	spec, sum, err := s.read()
	if err != nil {
		return false, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if sum == s.sum {
		return false, false, nil
	}
	if s.m != nil {
		s.m.PricingReload.WithLabelValues("ok").Inc()
	}
	s.spec, s.sum = spec, sum
	s.resetPGCacheLocked()
	if s.m != nil {
		s.m.PricingModels.Set(float64(len(spec.Models)))
	}
	if s.onLoad != nil {
		s.onLoad(*spec)
	}
	return true, true, nil
}

// resetPGCacheLocked 重建 PG 兜底缓存（正缓存按 reload 周期，负缓存 5s）。需持有写锁。
func (s *Service) resetPGCacheLocked() {
	s.pgPos, s.pgNeg = nil, nil
	if s.cfg.PGFallback {
		s.pgPos = cache.New[string, store.ModelPrice](10000, s.cfgReloadTTL())
		s.pgNeg = cache.New[string, empty](10000, 5*time.Second)
	}
}

func (s *Service) cfgReloadTTL() time.Duration {
	if s.cfg.ReloadInterval > 0 {
		return s.cfg.ReloadInterval
	}
	return 30 * time.Second
}

func (s *Service) read() (*Spec, string, error) {
	b, err := os.ReadFile(s.cfg.ConfigMapPath)
	if err != nil {
		if s.m != nil {
			s.m.PricingReload.WithLabelValues("error").Inc()
		}
		return nil, "", fmt.Errorf("read pricing file: %w", err)
	}
	spec, err := ParseSpec(b)
	if err != nil {
		if s.m != nil {
			s.m.PricingReload.WithLabelValues("error").Inc()
		}
		return nil, "", err
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(b))
	return spec, sum, nil
}

// Spec 返回当前生效的配置。
func (s *Service) Spec() (*Spec, string, error) {
	select {
	case <-s.loaded:
	case <-time.After(5 * time.Second):
		return nil, "", errors.New("pricing not loaded")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.spec, s.sum, nil
}

// Lookup 查找 PriceCard：ConfigMap → PG → unknown_model 策略。
func (s *Service) Lookup(ctx context.Context, model, group string) (PriceCard, error) {
	if model == "" {
		return PriceCard{}, ErrNotPriced
	}
	spec, _, err := s.Spec()
	if err != nil {
		return PriceCard{}, err
	}
	gr := spec.GroupRatio(group)
	if m, ok := spec.Models[model]; ok {
		if s.m != nil {
			s.m.PricingLookups.WithLabelValues(loom.PriceSourceConfigMap).Inc()
		}
		return BuildCard(model, group, gr, m, spec.Defaults, s.reserve, loom.PriceSourceConfigMap), nil
	}
	if s.cfg.PGFallback && s.st != nil {
		if row, ok := s.lookupPG(ctx, model); ok {
			if s.m != nil {
				s.m.PricingLookups.WithLabelValues(loom.PriceSourcePG).Inc()
			}
			m := RowFromPG([3]float64{row.ModelRatio, row.CompletionRatio, row.CacheRatio}, row.ModelPrice, row.ReserveInputTokens, row.ReserveOutputTokens)
			return BuildCard(model, group, gr, m, spec.Defaults, s.reserve, loom.PriceSourcePG), nil
		}
	}
	if spec.Defaults.UnknownModel == UnknownDefault {
		if s.m != nil {
			s.m.PricingLookups.WithLabelValues(loom.PriceSourceDefault).Inc()
		}
		return BuildCard(model, group, gr, ModelSpec{}, spec.Defaults, s.reserve, loom.PriceSourceDefault), nil
	}
	if s.m != nil {
		s.m.PricingLookups.WithLabelValues("miss").Inc()
	}
	return PriceCard{}, ErrNotPriced
}

func (s *Service) lookupPG(ctx context.Context, model string) (store.ModelPrice, bool) {
	s.mu.RLock()
	pos, neg := s.pgPos, s.pgNeg
	s.mu.RUnlock()
	miss := func() (store.ModelPrice, bool) {
		if s.m != nil {
			s.m.AuthCacheHits.WithLabelValues("pricing", "miss").Inc()
		}
		return store.ModelPrice{}, false
	}
	if pos.Enabled() {
		if row, ok := pos.Get(model); ok {
			if s.m != nil {
				s.m.AuthCacheHits.WithLabelValues("pricing", "hit").Inc()
			}
			return row, true
		}
	}
	if neg.Enabled() {
		if _, ok := neg.Get(model); ok {
			return miss()
		}
	}
	row, err := s.st.GetModelPricing(ctx, model)
	if errors.Is(err, loom.ErrNotFound) {
		if neg.Enabled() {
			neg.Add(model, empty{})
		}
		return miss()
	}
	if err != nil {
		return miss()
	}
	if pos.Enabled() {
		pos.Add(model, row)
	}
	return row, true
}

// InvalidatePG 清除 PG 兜底缓存（管理 API 修改后调用）。
func (s *Service) InvalidatePG(model string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if model == "" {
		s.resetPGCacheLocked()
		return
	}
	s.pgPos.Remove(model)
	s.pgNeg.Remove(model)
}

// RenderCatalog 生成 agentgateway modelCatalog 的 catalog.json（按 token 计价的模型）。
func (s *Service) RenderCatalog() ([]byte, error) {
	spec, _, err := s.Spec()
	if err != nil {
		return nil, err
	}
	c := RenderCatalog(spec)
	return json.MarshalIndent(c, "", "  ")
}

// Catalog 生成 catalog.json（含 PG 兜底中按 token 计价的模型）。
func (s *Service) Catalog(ctx context.Context) (CatalogJSON, error) {
	spec, _, err := s.Spec()
	if err != nil {
		return nil, err
	}
	c := RenderCatalog(spec)
	if s.st != nil && s.cfg.PGFallback {
		rows, err := s.st.ListModelPricing(ctx)
		if err == nil {
			for _, r := range rows {
				if _, exists := spec.Models[r.Model]; exists {
					continue
				}
				if r.ModelPrice != nil {
					continue // 按次计费无法在网关目录表达
				}
				m := RowFromPG([3]float64{r.ModelRatio, r.CompletionRatio, r.CacheRatio}, nil, nil, nil)
				addModel(c, spec.Catalog.Provider, r.Model, m)
			}
		}
	}
	return c, nil
}

// CatalogJSON 见 agentgateway modelCatalog.sources[].configMap。
type CatalogJSON map[string]any

// RenderCatalog 由 Spec 生成 catalog.json 结构。
func RenderCatalog(spec *Spec) CatalogJSON {
	c := CatalogJSON{"providers": map[string]any{}}
	for model, m := range spec.Models {
		addModel(c, spec.Catalog.Provider, model, m)
	}
	return c
}

func addModel(c CatalogJSON, provider, model string, m ModelSpec) {
	if m.ModelPrice != nil {
		return
	}
	ratio := m.ModelRatio
	if ratio <= 0 {
		ratio = 1
	}
	in := ratio * 2 // USD / 1M tokens
	out := in
	if m.CompletionRatio > 0 {
		out = in * m.CompletionRatio
	}
	cache := in
	if m.CacheRatio > 0 {
		cache = in * m.CacheRatio
	}
	providers := c["providers"].(map[string]any)
	p, ok := providers[provider]
	if !ok {
		p = map[string]any{"models": map[string]any{}}
		providers[provider] = p
	}
	models := p.(map[string]any)["models"].(map[string]any)
	models[model] = map[string]any{"rates": map[string]string{"input": formatUSD(in), "output": formatUSD(out), "cacheRead": formatUSD(cache)}}
}

func formatUSD(v float64) string {
	// 消除二进制浮点噪声：0.14×2 = 0.28000000000000003 → 0.28
	return strconv.FormatFloat(math.Round(v*1e10)/1e10, 'f', -1, 64)
}
