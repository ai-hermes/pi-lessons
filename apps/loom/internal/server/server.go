// Package server 负责装配与生命周期：连接 PG、启动各监听器、优雅退出。
package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	logspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/admin"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/auth"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/billing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/quota"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/pg"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// Options 运行参数。
type Options struct {
	Version string
	Commit  string
}

// migrationLockID goose 迁移使用的 advisory lock 键（任意固定 bigint）。
const migrationLockID int64 = 0x1000_0001

// Open 连接 PG 并执行迁移，返回 store。
func Open(ctx context.Context, cfg *config.Config, m *telemetry.Metrics, log *slog.Logger, migrationsFS fs.FS) (*pg.DB, error) {
	dsn, err := cfg.Postgres.ResolveDSN()
	if err != nil {
		return nil, err
	}
	db, err := pg.New(ctx, dsn, cfg.Postgres.MinConns, cfg.Postgres.MaxConns, cfg.Postgres.MaxConnLifetime, cfg.Postgres.StatementTimeout)
	if err != nil {
		return nil, err
	}
	if m != nil {
		db.SetErrorHandler(func(op string, err error) { m.PGErrors.WithLabelValues(op).Inc() })
	}
	if cfg.Migrations.Auto {
		// 多副本同时启动时用 PG advisory lock 串行化迁移，避免第二个副本因表已存在而失败
		conn, err := db.Pool().Acquire(ctx)
		if err != nil {
			db.Close()
			return nil, err
		}
		if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLockID); err != nil {
			conn.Release()
			db.Close()
			return nil, fmt.Errorf("acquire migration lock: %w", err)
		}
		defer func() {
			_, _ = conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", migrationLockID)
			conn.Release()
		}()
		if err := db.Migrate(ctx, migrationsFS, "."); err != nil {
			db.Close()
			return nil, fmt.Errorf("migrate: %w", err)
		}
		log.Info("migrations applied")
	}
	return db, nil
}

// Components 装配好的组件集合，供 CLI 与测试复用。
type Components struct {
	Cfg     *config.Config
	Log     *slog.Logger
	Metrics *telemetry.Metrics
	DB      *pg.DB
	Store   store.Store
	Pricing *pricing.Service
	Quota   *quota.Service
	Auth    *auth.Engine
	Ingest  *billing.Ingest
	Admin   *admin.Service
}

// Build 构建组件（不启动后台任务以外的监听器）。
func Build(ctx context.Context, cfg *config.Config, db *pg.DB, m *telemetry.Metrics, log *slog.Logger) (*Components, error) {
	st := store.Store(db)
	pr := pricing.NewService(cfg.Pricing, cfg.Quota.ReserveTokens, st, m, log)
	if err := pr.Start(ctx, cfg.Pricing.ReloadInterval); err != nil {
		return nil, err
	}
	q := quota.NewService(cfg.Quota, st, m, log)
	engine := auth.NewEngine(cfg.Auth, st, pr, q, m, log)
	resolver := billing.NewResolver(st, cfg.Pricing.AccountCacheTTL)
	ingest := billing.NewIngest(cfg.Billing, st, pr, m, log, resolver)
	svc := admin.NewService(st, pr, cfg.Admin.DefaultKeyPrefix)
	return &Components{Cfg: cfg, Log: log, Metrics: m, DB: db, Store: st, Pricing: pr, Quota: q, Auth: engine, Ingest: ingest, Admin: svc}, nil
}

// Close 释放组件。
func (c *Components) Close() {
	c.Pricing.Stop()
	c.Auth.Close()
	if c.DB != nil {
		_ = c.DB.Close()
	}
}

// Run 启动所有监听器并阻塞到信号。
func Run(ctx context.Context, cfg *config.Config, opts Options, migrationsFS fs.FS) error {
	log := telemetry.NewLogger(cfg.Log.Level, cfg.Log.Format)
	if strings.ToLower(cfg.Log.Format) != "text" {
		slog.SetDefault(log)
	}
	m := telemetry.NewMetrics(orDefault(opts.Version, "dev"), orDefault(opts.Commit, "none"))
	db, err := Open(ctx, cfg, m, log, migrationsFS)
	if err != nil {
		return err
	}
	c, err := Build(ctx, cfg, db, m, log)
	if err != nil {
		db.Close()
		return err
	}
	defer c.Close()

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	ready := &atomic.Bool{}
	ready.Store(true)
	var wg sync.WaitGroup
	errCh := make(chan error, 8)
	lc := net.Listen

	// :9001 extAuth HTTP + 探针
	if addr := cfg.Server.ExtAuthHTTPAddr; addr != "" {
		srv := &http.Server{Addr: addr, Handler: c.Auth.HTTPHandler(ready.Load), ReadHeaderTimeout: 10 * time.Second}
		go serve(ctx, srv, lc, log, errCh, &wg, "extauth-http", addr)
	}
	// :9002 extAuth gRPC
	if addr := cfg.Server.ExtAuthGRPCAddr; addr != "" {
		gs := grpc.NewServer()
		authv3.RegisterAuthorizationServer(gs, auth.NewGRPCServer(c.Auth))
		healthpb.RegisterHealthServer(gs, health.NewServer())
		reflection.Register(gs)
		go serveGRPC(ctx, gs, lc, log, errCh, &wg, "extauth-grpc", addr)
	}
	// :9100 管理 API
	if addr := cfg.Server.AdminAddr; addr != "" {
		gin.SetMode(gin.ReleaseMode)
		r := gin.New()
		r.Use(gin.Recovery())
		token, err := cfg.Admin.AdminToken()
		if err != nil {
			return err
		}
		admin.NewHandlers(c.Admin, c.Auth, token).Register(r, ready.Load)
		srv := &http.Server{Addr: addr, Handler: r, ReadHeaderTimeout: 10 * time.Second}
		go serve(ctx, srv, lc, log, errCh, &wg, "admin-http", addr)
	}
	// :9101 OTLP ingest
	if addr := cfg.Server.OTLPGRPCAddr; addr != "" {
		gs := grpc.NewServer()
		logspb.RegisterLogsServiceServer(gs, billing.NewLogsServer(c.Ingest, cfg.Billing.Attributes))
		tracepb.RegisterTraceServiceServer(gs, billing.NewTracesServer(c.Ingest))
		healthpb.RegisterHealthServer(gs, health.NewServer())
		reflection.Register(gs)
		go serveGRPC(ctx, gs, lc, log, errCh, &wg, "otlp-grpc", addr)
	}
	// :9102 metrics + pprof
	if addr := cfg.Server.MetricsAddr; addr != "" && cfg.Telemetry.Metrics.Enabled {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{}))
		mux.HandleFunc("/debug/pprof/", pprof.Index)
		mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
		mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
		mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
		mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
		srv := &http.Server{Addr: addr, Handler: mux}
		go serve(ctx, srv, lc, log, errCh, &wg, "metrics-http", addr)
	}

	// 后台任务
	wg.Add(3)
	go func() { defer wg.Done(); c.Quota.Reaper(ctx) }()
	go func() { defer wg.Done(); c.Ingest.Start(ctx) }()
	go func() {
		defer wg.Done()
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				ready.Store(c.DB.Ping(ctx) == nil)
				c.Quota.RefreshOpenGauge(ctx)
				c.Quota.RefreshAccountGauges(ctx)
			}
		}
	}()

	log.Info("loom started", "version", opts.Version, "extauth_http", cfg.Server.ExtAuthHTTPAddr, "extauth_grpc", cfg.Server.ExtAuthGRPCAddr,
		"admin", cfg.Server.AdminAddr, "otlp", cfg.Server.OTLPGRPCAddr, "metrics", cfg.Server.MetricsAddr)

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received")
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listener failed", "err", err)
			stop()
		}
	}
	ready.Store(false)
	// 等待监听器退出（serve 内部在 ctx 结束时 Shutdown）
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(cfg.Server.ShutdownTimeout):
		log.Warn("shutdown timeout, exiting")
	}
	log.Info("loom stopped")
	return nil
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func serve(ctx context.Context, srv *http.Server, lc func(network, addr string) (net.Listener, error), log *slog.Logger, errCh chan error, wg *sync.WaitGroup, name, addr string) {
	ln, err := lc("tcp", addr)
	if err != nil {
		errCh <- fmt.Errorf("%s listen %s: %w", name, addr, err)
		return
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-ctx.Done()
		shctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shctx)
	}()
	log.Info("listening", "name", name, "addr", addr)
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		errCh <- fmt.Errorf("%s serve: %w", name, err)
	}
}

func serveGRPC(ctx context.Context, gs *grpc.Server, lc func(network, addr string) (net.Listener, error), log *slog.Logger, errCh chan error, wg *sync.WaitGroup, name, addr string) {
	ln, err := lc("tcp", addr)
	if err != nil {
		errCh <- fmt.Errorf("%s listen %s: %w", name, addr, err)
		return
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-ctx.Done()
		gs.GracefulStop()
	}()
	log.Info("listening", "name", name, "addr", addr)
	if err := gs.Serve(ln); err != nil {
		errCh <- fmt.Errorf("%s serve: %w", name, err)
	}
}
