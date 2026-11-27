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
func (s *Service) Run(ctx context.Context) error {
	signalCtx, stopSignals := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	token, err := s.cfg.Admin.ResolveToken()
	if err != nil {
		return err
	}
	grpcHealth := health.NewServer()
	dataPlane, grpcServer := s.dataServer(grpcHealth)
	opsPlane := s.opsServer(token)

	workerCtx, stopWorkers := context.WithCancel(context.WithoutCancel(ctx))
	var workers sync.WaitGroup
	for _, run := range []func(context.Context){
		s.prices.Run,
		s.ledger.RunReaper,
		s.gate.RunAuditWriter,
		s.queue.Run,
		s.caches.Run,
		func(ctx context.Context) { s.watchHealth(ctx, grpcHealth) },
	} {
		workers.Go(func() { run(workerCtx) })
	}

	s.ready.Store(true)
	serveErr := make(chan error, 2)
	for _, srv := range []*http.Server{dataPlane, opsPlane} {
		go func() { serveErr <- listenAndServe(signalCtx, srv) }()
	}
	s.log.Info(
		"loom started",
		"version", s.build.Version,
		"listen", s.cfg.Server.Listen,
		"ops_listen", s.cfg.Server.OpsListen,
	)

	select {
	case <-signalCtx.Done():
		s.log.Info("shutdown signal received")
	case err = <-serveErr:
		s.log.Error("listener failed", "err", err)
	}

	s.ready.Store(false)
	grpcHealth.Shutdown()
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.cfg.Server.ShutdownTimeout)
	defer cancel()
	for _, srv := range []*http.Server{dataPlane, opsPlane} {
		if shutdownErr := srv.Shutdown(shutdownCtx); shutdownErr != nil {
			s.log.Warn("server shutdown", "addr", srv.Addr, "err", shutdownErr)
		}
	}
	grpcServer.Stop()

	stopWorkers()
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-shutdownCtx.Done():
		s.log.Warn("background workers did not stop before shutdown timeout")
	}
	s.log.Info("loom stopped")
	return err
}

// dataServer 构建数据面：单端口 h2c，gRPC 与 HTTP 按 Content-Type 分流。
func (s *Service) dataServer(grpcHealth *health.Server) (*http.Server, *grpc.Server) {
	extOpts := extauthOptions(s.cfg.ExtAuth)

	extAuthz := extauth.NewGRPCServer(s.gate, extOpts)
	rateLimit := ratelimit.NewServer(s.ledger, s.cfg.RateLimit.Domain, s.metrics, s.log)
	logs := otlp.NewLogsServer(s.queue, otlp.AttributeNames(s.cfg.OTLP.AttributeNames))
	traces := otlp.NewTracesServer(s.metrics)

	gs := grpc.NewServer()
	authv3.RegisterAuthorizationServer(gs, extAuthz)
	rlsv3.RegisterRateLimitServiceServer(gs, rateLimit)
	logsv1.RegisterLogsServiceServer(gs, logs)
	tracev1.RegisterTraceServiceServer(gs, traces)
	healthpb.RegisterHealthServer(gs, grpcHealth)
	reflection.Register(gs)

	mux := http.NewServeMux()
	mux.Handle(extauth.CheckPath, extauth.NewHTTPHandler(s.gate, extOpts))

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
		Addr:              s.cfg.Server.Listen,
		Handler:           handler,
		Protocols:         protocols,
		ReadHeaderTimeout: readHeaderTimeout,
	}, gs
}

// opsServer 构建运维面：管理 API、指标、探针、pprof。
func (s *Service) opsServer(adminToken string) *http.Server {
	mux := http.NewServeMux()
	mux.Handle("/v1/", adminapi.New(s.accounts, adminToken).Handler())
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.metrics.Registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return &http.Server{Addr: s.cfg.Server.OpsListen, Handler: mux, ReadHeaderTimeout: readHeaderTimeout}
}

// handleHealthz 存活探针：进程在即返回 200。
func (s *Service) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

// handleReadyz 就绪探针：数据库不可达或正在停机时返回 503。
func (s *Service) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	if !s.ready.Load() {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	_, _ = w.Write([]byte("ready"))
}

// watchHealth 周期检查数据库，更新就绪状态与账本指标。
func (s *Service) watchHealth(ctx context.Context, grpcHealth *health.Server) {
	ticker := time.NewTicker(healthCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			healthy := s.db.Ping(ctx) == nil
			s.ready.Store(healthy)
			status := healthpb.HealthCheckResponse_SERVING
			if !healthy {
				status = healthpb.HealthCheckResponse_NOT_SERVING
			}
			grpcHealth.SetServingStatus("", status)
			s.ledger.RefreshGauges(ctx)
		}
	}
}

func listenAndServe(ctx context.Context, srv *http.Server) error {
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", srv.Addr, err)
	}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve %s: %w", srv.Addr, err)
	}
	return nil
}
