package main

import (
	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
)

// configLoader 加载配置；由根命令注入，便于统一 --config / LOOM_CONFIG 的解析。
type configLoader func() (*config.Config, error)

func newServeCmd(load configLoader) *cobra.Command {
	return &cobra.Command{
		Use:     "serve",
		GroupID: "run",
		Short:   "Start the service (data plane + ops plane)",
		Long: `Start loom with the data plane (extauth, ratelimit, otlp; one h2c port) and the
ops plane (admin API, metrics, health, pprof). Blocks until SIGINT or SIGTERM.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := load()
			if err != nil {
				return err
			}
			svc, err := app.New(cmd.Context(), cfg, app.BuildInfo{Version: version, Commit: commit})
			if err != nil {
				return err
			}
			defer svc.Close()
			return svc.Run(cmd.Context())
		},
	}
}
