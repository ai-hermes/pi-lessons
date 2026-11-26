// Package app 装配 loom 的全部组件并管理其生命周期：连接数据库、执行迁移、
// 构建准入 / 账本 / 价目表 / 管理服务，在数据面与运维面两个端口上提供服务。
package app

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/account"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/admission"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/ledger"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/postgres"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/transport/extauth"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/transport/otlp"
)

// BuildInfo 构建版本信息。
type BuildInfo struct {
	Version string
	Commit  string
}

// App 是装配完成的 loom 服务。
type App struct {
	cfg     *config.Config
	build   BuildInfo
	log     *slog.Logger
	metrics *telemetry.Metrics

	db       *postgres.DB
	prices   *pricing.Table
	ledger   *ledger.Ledger
	gate     *admission.Gate
	accounts *account.Service
	queue    *otlp.Queue

	ready atomic.Bool
}

// New 连接数据库（按需执行迁移）并装配全部组件。
func New(ctx context.Context, cfg *config.Config, build BuildInfo) (*App, error) {
	log := telemetry.NewLogger(cfg.Log.Level, cfg.Log.Format)
	if !strings.EqualFold(cfg.Log.Format, "text") {
		slog.SetDefault(log)
	}
	metrics := telemetry.NewMetrics(orDefault(build.Version, "dev"), orDefault(build.Commit, "none"))

	db, err := openStore(ctx, cfg, metrics, log)
	if err != nil {
		return nil, err
	}
	a, err := wire(cfg, db, metrics, log)
	if err != nil {
		db.Close()
		return nil, err
	}
	a.build = build
	return a, nil
}

// Close 释放数据库连接。
func (a *App) Close() {
	a.prices.Close()
	a.db.Close()
}

// wire 用已打开的数据库装配业务组件。
func wire(cfg *config.Config, db *postgres.DB, metrics *telemetry.Metrics, log *slog.Logger) (*App, error) {
	prices, err := pricing.New(pricing.Options{
		File:           cfg.Pricing.File,
		ReloadInterval: cfg.Pricing.ReloadInterval,
		StoreFallback:  cfg.Pricing.StoreFallback,
		Reserve:        pricing.ReserveTokens(cfg.Ledger.ReserveTokens),
	}, db, metrics, log)
	if err != nil {
		return nil, fmt.Errorf("load pricing: %w", err)
	}

	l := ledger.New(ledger.Options{
		ReservationTTL: cfg.Ledger.ReservationTTL,
		ReaperInterval: cfg.Ledger.ReaperInterval,
		ReaperBatch:    cfg.Ledger.ReaperBatch,
		CostSource:     ledger.CostSource(cfg.Ledger.CostSource),
		OwnerCacheTTL:  cfg.Ledger.OwnerCacheTTL,
	}, db, prices, metrics, log)

	gate := admission.New(admission.Options{
		KeyCache:   admission.KeyCacheOptions(cfg.Admission.KeyCache),
		AuditQueue: cfg.Admission.AuditQueue,
	}, admission.Deps{Store: db, Pricer: prices, Reserver: l, Metrics: metrics, Log: log})

	queue := otlp.NewQueue(otlp.QueueOptions{
		Protocols:     cfg.OTLP.Protocols,
		Size:          cfg.OTLP.QueueSize,
		BatchSize:     cfg.OTLP.BatchSize,
		FlushInterval: cfg.OTLP.FlushInterval,
	}, l, metrics, log)

	return &App{
		cfg:      cfg,
		log:      log,
		metrics:  metrics,
		db:       db,
		prices:   prices,
		ledger:   l,
		gate:     gate,
		accounts: account.New(db, prices, gate, cfg.Admin.KeyPrefix),
		queue:    queue,
	}, nil
}

// openStore 连接 PostgreSQL，注册连接池指标，并在 migrations.auto 时执行迁移。
func openStore(
	ctx context.Context,
	cfg *config.Config,
	metrics *telemetry.Metrics,
	log *slog.Logger,
) (*postgres.DB, error) {
	dsn, err := cfg.Postgres.ResolveDSN()
	if err != nil {
		return nil, err
	}
	db, err := postgres.New(ctx, postgres.Options{
		DSN:              dsn,
		MinConns:         cfg.Postgres.MinConns,
		MaxConns:         cfg.Postgres.MaxConns,
		MaxConnLifetime:  cfg.Postgres.MaxConnLifetime,
		StatementTimeout: cfg.Postgres.StatementTimeout,
	})
	if err != nil {
		return nil, err
	}
	db.SetErrorHandler(func(op string, _ error) { metrics.StoreErrors.WithLabelValues(op).Inc() })
	metrics.RegisterPoolStats(db.Stat)
	if cfg.Migrations.Auto {
		applied, err := db.Migrate(ctx, postgres.MigrateUp)
		if err != nil {
			db.Close()
			return nil, err
		}
		log.Info("migrations applied", "count", len(applied))
	}
	return db, nil
}

// extauthOptions 把配置翻译为 extauth 门面参数。
func extauthOptions(cfg config.ExtAuth) extauth.Options {
	deny := make(map[admission.Reason]int, len(cfg.DenyStatus))
	for reason, status := range cfg.DenyStatus {
		deny[admission.Reason(reason)] = status
	}
	h := cfg.Headers
	return extauth.Options{
		Headers: extauth.Headers{
			Credentials:     cfg.CredentialHeaders,
			ClientRequestID: h.ClientRequestID,
			Model:           h.Model,
			Account:         h.Account,
			KeyID:           h.KeyID,
			RequestID:       h.RequestID,
			QuotaRemaining:  h.QuotaRemaining,
			DenyReason:      h.DenyReason,
		},
		DenyStatus: deny,
		BodyLimit:  cfg.BodyLimit,
	}
}

func otlpAttributes(a config.OTLPAttributes) otlp.Attributes { return otlp.Attributes(a) }

func orDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
