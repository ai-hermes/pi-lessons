package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/pprof"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	rlsv3 "github.com/envoyproxy/go-control-plane/envoy/service/ratelimit/v3"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	logsv1 "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/transport/adminapi"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/transport/extauth"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/transport/otlp"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/transport/ratelimit"
)

const (
	readHeaderTimeout   = 10 * time.Second
	healthCheckInterval = 15 * time.Second
)

// Run 启动两个端口与后台任务，阻塞到收到 SIGINT / SIGTERM 或某个端口异常退出。
//
// 停机顺序：先关闭两个端口（不再接收新请求、等待进行中的请求结束），
// 再停止后台任务，让 OTLP 补账队列与审计队列把已收到的数据写完。
func (a *App) Run(ctx context.Context) error {
	signalCtx, stopSignals := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	token, err := a.cfg.Admin.ResolveToken()
	if err != nil {
		return err
	}
	grpcHealth := health.NewServer()
	dataPlane, grpcServer := a.dataServer(grpcHealth)
	opsPlane := a.opsServer(token)

	workerCtx, stopWorkers := context.WithCancel(context.WithoutCancel(ctx))
	var workers sync.WaitGroup
	for _, run := range []func(context.Context){
		a.prices.Run,
		a.ledger.RunReaper,
		a.gate.RunAuditWriter,
		a.queue.Run,
		func(ctx context.Context) { a.watchHealth(ctx, grpcHealth) },
	} {
		workers.Go(func() { run(workerCtx) })
	}

	a.ready.Store(true)
	serveErr := make(chan error, 2)
	for _, srv := range []*http.Server{dataPlane, opsPlane} {
		go func() { serveErr <- listenAndServe(srv) }()
	}
	a.log.Info(
		"loom started",
		"version",
		a.build.Version,
		"listen",
		a.cfg.Server.Listen,
		"ops_listen",
		a.cfg.Server.OpsListen,
	)

	select {
	case <-signalCtx.Done():
		a.log.Info("shutdown signal received")
	case err = <-serveErr:
		a.log.Error("listener failed", "err", err)
	}

	a.ready.Store(false)
	grpcHealth.Shutdown()
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), a.cfg.Server.ShutdownTimeout)
	defer cancel()
	for _, srv := range []*http.Server{dataPlane, opsPlane} {
		if shutdownErr := srv.Shutdown(shutdownCtx); shutdownErr != nil {
			a.log.Warn("server shutdown", "addr", srv.Addr, "err", shutdownErr)
		}
	}
	grpcServer.Stop()

	stopWorkers()
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-shutdownCtx.Done():
		a.log.Warn("background workers did not stop before shutdown timeout")
	}
	a.log.Info("loom stopped")
	return err
}

// dataServer 构建数据面：单端口 h2c，gRPC 与 HTTP 按 Content-Type 分流。
func (a *App) dataServer(grpcHealth *health.Server) (*http.Server, *grpc.Server) {
	extOpts := extauthOptions(a.cfg.ExtAuth)

	gs := grpc.NewServer()
	authv3.RegisterAuthorizationServer(gs, extauth.NewGRPCServer(a.gate, extOpts))
	rlsv3.RegisterRateLimitServiceServer(gs, ratelimit.NewServer(a.ledger, a.cfg.RateLimit.Domain, a.metrics, a.log))
	logsv1.RegisterLogsServiceServer(gs, otlp.NewLogsServer(a.queue, otlpAttributes(a.cfg.OTLP.Attributes)))
	tracev1.RegisterTraceServiceServer(gs, otlp.NewTracesServer(a.metrics))
	healthpb.RegisterHealthServer(gs, grpcHealth)
	reflection.Register(gs)

	mux := http.NewServeMux()
	mux.Handle(extauth.CheckPath, extauth.NewHTTPHandler(a.gate, extOpts))

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor == 2 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc") {
			gs.ServeHTTP(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})

	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true) // 网关以 HTTP/2 prior knowledge 调 gRPC
	return &http.Server{
		Addr:              a.cfg.Server.Listen,
		Handler:           handler,
		Protocols:         protocols,
		ReadHeaderTimeout: readHeaderTimeout,
	}, gs
}

// opsServer 构建运维面：管理 API、指标、探针、pprof。
func (a *App) opsServer(adminToken string) *http.Server {
	mux := http.NewServeMux()
	mux.Handle("/v1/", adminapi.New(a.accounts, adminToken).Handler())
	mux.Handle("GET /metrics", promhttp.HandlerFor(a.metrics.Registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !a.ready.Load() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ready"))
	})
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return &http.Server{Addr: a.cfg.Server.OpsListen, Handler: mux, ReadHeaderTimeout: readHeaderTimeout}
}

// watchHealth 周期检查数据库，更新就绪状态与账本指标。
func (a *App) watchHealth(ctx context.Context, grpcHealth *health.Server) {
	ticker := time.NewTicker(healthCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			healthy := a.db.Ping(ctx) == nil
			a.ready.Store(healthy)
			status := healthpb.HealthCheckResponse_SERVING
			if !healthy {
				status = healthpb.HealthCheckResponse_NOT_SERVING
			}
			grpcHealth.SetServingStatus("", status)
			a.ledger.RefreshGauges(ctx)
		}
	}
}

func listenAndServe(srv *http.Server) error {
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", srv.Addr, err)
	}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve %s: %w", srv.Addr, err)
	}
	return nil
}
