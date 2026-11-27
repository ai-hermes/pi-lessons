// Package app 装配 loom 的全部组件并管理其生命周期：连接数据库、执行迁移、
// 构建准入 / 账本 / 价目表 / 管理服务，在数据面与运维面两个端口上提供服务。
package app

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/account"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/admission"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/cachesync"
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

// Service 是装配完成的 loom 服务。
type Service struct {
	cfg     *config.Config
	build   BuildInfo
	log     *slog.Logger
	metrics *telemetry.Metrics

	db       *postgres.DB
	prices   *pricing.PriceTable
	ledger   *ledger.Ledger
	gate     *admission.Gate
	accounts *account.Service
	queue    *otlp.Queue
	caches   *cachesync.Syncer

	ready atomic.Bool
}

// New 连接数据库（按需执行迁移）并装配全部组件。
func New(ctx context.Context, cfg *config.Config, build BuildInfo) (*Service, error) {
	log := telemetry.NewLogger(cfg.Log.Level, cfg.Log.Format)
	if !strings.EqualFold(cfg.Log.Format, "text") {
		slog.SetDefault(log)
	}
	build.Version = orDefault(build.Version, "dev")
	build.Commit = orDefault(build.Commit, "none")
	metrics := telemetry.NewMetrics(build.Version, build.Commit)

	db, err := openStore(ctx, cfg, metrics, log)
	if err != nil {
		return nil, err
	}
	svc, err := wire(cfg, db, metrics, log)
	if err != nil {
		db.Close()
		return nil, err
	}
	svc.build = build
	return svc, nil
}

// Close 释放数据库连接。
func (s *Service) Close() {
	s.prices.Close()
	s.db.Close()
}

// wire 用已打开的数据库装配业务组件。
func wire(cfg *config.Config, db *postgres.DB, metrics *telemetry.Metrics, log *slog.Logger) (*Service, error) {
	priceOpts := pricing.Options{
		File:                    cfg.Pricing.File,
		ReloadInterval:          cfg.Pricing.ReloadInterval,
		DatabaseFallbackEnabled: cfg.Pricing.DatabaseFallbackEnabled,
		Reserve:                 pricing.ReserveEstimate(cfg.Ledger.ReserveEstimate),
	}
	prices, err := pricing.New(priceOpts, db, metrics, log)
	if err != nil {
		return nil, fmt.Errorf("load pricing: %w", err)
	}

	ledgerOpts := ledger.Options{
		ReservationTTL: cfg.Ledger.ReservationTTL,
		ReaperInterval: cfg.Ledger.ReaperInterval,
		ReaperBatch:    cfg.Ledger.ReaperBatch,
		CostSource:     ledger.CostSource(cfg.Ledger.CostSource),
		OwnerCacheTTL:  cfg.Ledger.OwnerCacheTTL,
	}
	billingLedger := ledger.New(ledgerOpts, db, prices, metrics, log)

	gateOpts := admission.Options{
		APIKeyCache: admission.APIKeyCacheOptions(cfg.Admission.APIKeyCache),
		AuditQueue:  cfg.Admission.AuditQueue,
	}
	gate := admission.New(
		gateOpts,
		db,
		prices,
		billingLedger,
		metrics,
		log,
	)

	queueOpts := otlp.QueueOptions{
		Protocols:     cfg.OTLP.Protocols,
		Size:          cfg.OTLP.QueueSize,
		BatchSize:     cfg.OTLP.BatchSize,
		FlushInterval: cfg.OTLP.FlushInterval,
	}
	queue := otlp.NewQueue(queueOpts, billingLedger, metrics, log)

	localCaches := cachesync.Caches{
		APIKey:     []func(uuid.UUID){gate.InvalidateAPIKey, billingLedger.InvalidateAPIKey},
		Account:    []func(uuid.UUID){gate.InvalidateAccount, billingLedger.InvalidateAccount},
		ModelPrice: []func(string){prices.InvalidateFallbackCache},
	}
	caches := cachesync.New(db, localCaches, metrics, log)

	return &Service{
		cfg:      cfg,
		log:      log,
		metrics:  metrics,
		db:       db,
		prices:   prices,
		ledger:   billingLedger,
		gate:     gate,
		accounts: account.New(db, prices, cfg.Admin.KeyPrefix, caches),
		queue:    queue,
		caches:   caches,
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
		ListenDSN:        cfg.Postgres.ListenDSN,
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
			APIKeyID:        h.APIKeyID,
			RequestID:       h.RequestID,
			QuotaRemaining:  h.QuotaRemaining,
			DenyReason:      h.DenyReason,
		},
		DenyStatus: deny,
		BodyLimit:  cfg.BodyLimit,
	}
}

func orDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
