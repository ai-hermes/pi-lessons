package main

import (
	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
)

func newServeCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "serve",
		GroupID: "run",
		Annotations: map[string]string{
			requiresConfigAnnotation: "true",
		},
		Short: "Run Loom's extAuth and billing services",
		Long: `Start Loom and connect its authentication and billing capabilities to AgentGateway.

The service validates API keys and quotas, records model usage and cost, and
exposes the administration API, health checks, and operational metrics.
It continues running until it receives SIGINT or SIGTERM.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg := config.MustGet()
			info := app.BuildInfo{Version: version, Commit: commit}
			svc, err := app.New(cmd.Context(), cfg, info)
			if err != nil {
				return err
			}
			defer svc.Close()
			return svc.Run(cmd.Context())
		},
	}
}
