package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/account"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/cachesync"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/postgres"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// 一次性子命令：不启动监听器，只连接所需的依赖。

// Migrate 执行数据库迁移（up | down | status），返回结果摘要。
func Migrate(ctx context.Context, cfg *config.Config, action postgres.MigrationAction) ([]string, error) {
	dsn, err := cfg.Postgres.ResolveDSN()
	if err != nil {
		return nil, err
	}
	db, err := postgres.New(ctx, postgres.Options{DSN: dsn, MinConns: 1, MaxConns: 2})
	if err != nil {
		return nil, err
	}
	defer db.Close()
	return db.Migrate(ctx, action)
}

// Seed 幂等写入 seed 文件中的账户、Key 与 PG 兜底定价，返回操作摘要。
func Seed(ctx context.Context, cfg *config.Config, path string) ([]string, error) {
	log := telemetry.NewLogger("warn", "text")
	metrics := telemetry.NewMetrics("seed", "none")
	db, err := openStore(ctx, cfg, metrics, log)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	priceOpts := pricing.Options{File: cfg.Pricing.File, DatabaseFallbackEnabled: cfg.Pricing.DatabaseFallbackEnabled}
	prices, err := pricing.New(priceOpts, db, metrics, log)
	if err != nil {
		return nil, fmt.Errorf("load pricing: %w", err)
	}
	// seed 进程没有缓存，只负责广播，让在线副本立即看到变更
	caches := cachesync.New(db, cachesync.Caches{}, metrics, log)
	return account.New(db, prices, cfg.Admin.KeyPrefix, caches).Seed(ctx, path)
}

// RenderAgentGatewayCatalog 把 pricing.yaml 渲染为 agentgateway modelCatalog 的 catalog.json。
func RenderAgentGatewayCatalog(pricingFile string, w io.Writer) error {
	priceConfig, err := pricing.LoadPriceConfig(pricingFile)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(pricing.RenderAgentGatewayCatalog(priceConfig))
}

// CheckConfig 校验配置与 pricing.yaml，输出生效的端口与价目表。
func CheckConfig(cfg *config.Config, w io.Writer) error {
	priceConfig, err := pricing.LoadPriceConfig(cfg.Pricing.File)
	if err != nil {
		return err
	}
	var b strings.Builder
	server, reserve, defaults := cfg.Server, cfg.Ledger.ReserveEstimate, priceConfig.Defaults
	fmt.Fprintf(
		&b,
		"config ok: listen=%s ops_listen=%s ratelimit.domain=%s\n",
		server.Listen,
		server.OpsListen,
		cfg.RateLimit.Domain,
	)
	fmt.Fprintf(
		&b,
		"pricing: %d models, unknown_model=%s, reserve_tokens=%d/%d\n",
		len(priceConfig.Models),
		defaults.UnknownModel,
		reserve.Input,
		reserve.Output,
	)

	groupNames := slices.Sorted(maps.Keys(priceConfig.Groups))
	for _, name := range groupNames {
		fmt.Fprintf(&b, "  group %-22s ratio=%v\n", name, priceConfig.Groups[name].Ratio)
	}
	for _, name := range priceConfig.SortedModelNames() {
		m := priceConfig.Models[name]
		if m.ModelPrice != nil {
			fmt.Fprintf(&b, "  %-28s per_call=$%v\n", name, *m.ModelPrice)
			continue
		}
		fmt.Fprintf(
			&b,
			"  %-28s ratio=%-6v completion=%-4v cache=%-4v\n",
			name,
			m.ModelRatio,
			m.CompletionRatio,
			m.CacheRatio,
		)
	}
	_, err = io.WriteString(w, b.String())
	return err
}
