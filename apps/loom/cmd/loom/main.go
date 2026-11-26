// Command loom 是 AgentGateway 的外挂鉴权与计费服务。
//
//	loom serve           启动服务（数据面 :8080、运维面 :9090）
//	loom migrate ACTION  执行数据库迁移：up | down | status
//	loom seed --file F   幂等写入演示账户、Key 与 PG 兜底定价
//	loom render-catalog  把 pricing.yaml 渲染为网关 modelCatalog
//	loom check-config    校验配置并打印生效的价目表
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/postgres"
)

var (
	version = "dev"
	commit  = "none"
)

const usage = `usage: loom <command> [flags]

commands:
  serve                 start the service (data plane + ops plane)
  migrate up|down|status
  seed --file FILE      seed accounts, keys and pg pricing
  render-catalog --pricing FILE [--out FILE]
  check-config
  version

common flags:
  --config FILE         config.yaml (default: $LOOM_CONFIG or ./config.yaml)
`

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "loom:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return errors.New("missing command")
	}
	cmd, args := args[0], args[1:]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	configPath := fs.String("config", "", "path to config.yaml")

	switch cmd {
	case "serve":
		_ = fs.Parse(args)
		cfg, err := loadConfig(*configPath)
		if err != nil {
			return err
		}
		svc, err := app.New(ctx, cfg, app.BuildInfo{Version: version, Commit: commit})
		if err != nil {
			return err
		}
		defer svc.Close()
		return svc.Run(ctx)

	case "migrate":
		_ = fs.Parse(args)
		if fs.NArg() != 1 {
			return errors.New("usage: loom migrate up|down|status")
		}
		cfg, err := loadConfig(*configPath)
		if err != nil {
			return err
		}
		return printLines(app.Migrate(ctx, cfg, postgres.MigrationAction(fs.Arg(0))))

	case "seed":
		file := fs.String("file", "", "seed yaml")
		_ = fs.Parse(args)
		if *file == "" {
			return errors.New("--file is required")
		}
		cfg, err := loadConfig(*configPath)
		if err != nil {
			return err
		}
		return printLines(app.Seed(ctx, cfg, *file))

	case "render-catalog":
		pricingFile := fs.String("pricing", "", "pricing.yaml")
		out := fs.String("out", "", "output file (default stdout)")
		_ = fs.Parse(args)
		if *pricingFile == "" {
			return errors.New("--pricing is required")
		}
		if *out == "" {
			return app.RenderGatewayCatalog(*pricingFile, os.Stdout)
		}
		f, err := os.Create(*out)
		if err != nil {
			return err
		}
		if err := app.RenderGatewayCatalog(*pricingFile, f); err != nil {
			_ = f.Close()
			return err
		}
		return f.Close()

	case "check-config":
		_ = fs.Parse(args)
		cfg, err := loadConfig(*configPath)
		if err != nil {
			return err
		}
		return app.CheckConfig(cfg, os.Stdout)

	case "version", "--version", "-v":
		fmt.Printf("loom %s (%s)\n", version, commit)
		return nil

	case "help", "--help", "-h":
		fmt.Print(usage)
		return nil
	}
	fmt.Fprint(os.Stderr, usage)
	return fmt.Errorf("unknown command %q", cmd)
}

// loadConfig 依次使用 --config、$LOOM_CONFIG、./config.yaml（存在时）。
func loadConfig(path string) (*config.Config, error) {
	if path == "" {
		path = os.Getenv("LOOM_CONFIG")
	}
	if path == "" {
		if _, err := os.Stat("config.yaml"); err == nil {
			path = "config.yaml"
		}
	}
	return config.Load(path)
}

func printLines(lines []string, err error) error {
	for _, line := range lines {
		fmt.Println(line)
	}
	return err
}
