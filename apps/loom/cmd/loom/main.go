// Command loom 是 AgentGateway 的外挂鉴权与计费服务（织机：把多家模型「编织」成一张网）。
//
// 子命令：serve | migrate | render-catalog | check-config | seed
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/pressly/goose/v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/admin"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/server"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
	"github.com/ai-hermes/pi-lessons/apps/loom/migrations"
)

var version = "dev"
var commit = "none"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "loom:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return usage()
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "serve":
		return serve(rest)
	case "migrate":
		return migrate(rest)
	case "render-catalog":
		return renderCatalog(rest)
	case "check-config":
		return checkConfig(rest)
	case "seed":
		return seed(rest)
	case "version", "-v", "--version":
		fmt.Printf("loom %s (%s)\n", version, commit)
		return nil
	case "help", "-h", "--help":
		return usage()
	}
	return fmt.Errorf("unknown command %q\n%v", cmd, usage())
}

func usage() error {
	fmt.Fprint(os.Stderr, `loom - extAuth + billing for AgentGateway

usage: loom <command> [flags]

commands:
  serve            start all listeners (extAuth HTTP/gRPC, admin API, OTLP ingest, metrics)
  migrate up|down|status   run database migrations
  render-catalog   render agentgateway modelCatalog catalog.json from pricing.yaml
  check-config     validate config.yaml and print the effective price table
  seed             idempotently seed accounts / keys / pg pricing from a YAML file
  version          print version
`)
	return nil
}

type commonFlags struct {
	config  string
	verbose bool
}

func (c *commonFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&c.config, "config", "", "path to config.yaml (env LOOM_CONFIG; default config.yaml if present)")
}

func (c *commonFlags) resolve() (string, error) {
	path := c.config
	if path == "" {
		path = os.Getenv("LOOM_CONFIG")
	}
	if path == "" {
		if _, err := os.Stat("config.yaml"); err == nil {
			path = "config.yaml"
		}
	}
	return path, nil
}

func loadConfig(c *commonFlags) (*config.Config, error) {
	path, err := c.resolve()
	if err != nil {
		return nil, err
	}
	cfg, err := config.Load(path)
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var cf commonFlags
	cf.register(fs)
	_ = fs.Parse(args)
	cfg, err := loadConfig(&cf)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return server.Run(ctx, cfg, server.Options{Version: version, Commit: commit}, migrations.FS)
}

func migrate(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: loom migrate up|down|status")
	}
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	var cf commonFlags
	cf.register(fs)
	_ = fs.Parse(args[1:])
	cfg, err := loadConfig(&cf)
	if err != nil {
		return err
	}
	ctx := context.Background()
	db, err := server.Open(ctx, &config.Config{Postgres: cfg.Postgres, Migrations: config.Migrations{Auto: false}}, nil, telemetry.NewLogger("warn", "text"), migrations.FS)
	if err != nil {
		return err
	}
	defer db.Close()
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	sdb := db.SQL()
	defer sdb.Close()
	switch args[0] {
	case "up":
		return goose.UpContext(ctx, sdb, ".")
	case "down":
		return goose.DownContext(ctx, sdb, ".")
	case "status":
		return goose.StatusContext(ctx, sdb, ".")
	}
	return fmt.Errorf("unknown migrate action %q", args[0])
}

func renderCatalog(args []string) error {
	fs := flag.NewFlagSet("render-catalog", flag.ExitOnError)
	path := fs.String("pricing", "", "path to pricing.yaml")
	out := fs.String("out", "", "output file (default stdout)")
	_ = fs.Parse(args)
	if *path == "" {
		return errors.New("--pricing is required")
	}
	spec, err := loadSpec(*path)
	if err != nil {
		return err
	}
	b, err := marshalCatalog(spec)
	if err != nil {
		return err
	}
	if *out == "" {
		_, err = os.Stdout.Write(b)
		return err
	}
	return os.WriteFile(*out, b, 0o644)
}

func checkConfig(args []string) error {
	fs := flag.NewFlagSet("check-config", flag.ExitOnError)
	var cf commonFlags
	cf.register(fs)
	_ = fs.Parse(args)
	cfg, err := loadConfig(&cf)
	if err != nil {
		return err
	}
	spec, err := loadSpec(cfg.Pricing.ConfigMapPath)
	if err != nil {
		return err
	}
	reserve := cfg.Quota.ReserveTokens
	fmt.Printf("config ok: extauth_http=%s extauth_grpc=%s admin=%s otlp=%s metrics=%s\n",
		cfg.Server.ExtAuthHTTPAddr, cfg.Server.ExtAuthGRPCAddr, cfg.Server.AdminAddr, cfg.Server.OTLPGRPCAddr, cfg.Server.MetricsAddr)
	fmt.Printf("pricing: %d models, unknown_model=%s, reserve_tokens=%d/%d\n", len(spec.Models), spec.Defaults.UnknownModel, reserve.Input, reserve.Output)
	for _, m := range sortedModels(spec) {
		fmt.Printf("  %-28s ratio=%-6v completion=%-4v cache=%-4v\n", m, modelRatio(spec, m), completion(spec, m), cache(spec, m))
	}
	return nil
}

func seed(args []string) error {
	fs := flag.NewFlagSet("seed", flag.ExitOnError)
	var cf commonFlags
	cf.register(fs)
	file := fs.String("file", "", "seed YAML file")
	_ = fs.Parse(args)
	if *file == "" {
		return errors.New("--file is required")
	}
	cfg, err := loadConfig(&cf)
	if err != nil {
		return err
	}
	ctx := context.Background()
	log := telemetry.NewLogger("info", "text")
	db, err := server.Open(ctx, cfg, nil, log, migrations.FS)
	if err != nil {
		return err
	}
	defer db.Close()
	comp, err := server.Build(ctx, cfg, db, nil, log)
	if err != nil {
		return err
	}
	defer comp.Close()
	summary, err := admin.Seed(ctx, comp.Admin, *file)
	if err != nil {
		return err
	}
	for _, line := range summary {
		fmt.Println(line)
	}
	return nil
}
