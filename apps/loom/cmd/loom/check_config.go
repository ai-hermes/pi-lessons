package main

import (
	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
)

func newCheckConfigCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "check-config",
		GroupID: "tooling",
		Annotations: map[string]string{
			requiresConfigAnnotation: "true",
		},
		Short: "Validate Loom configuration and pricing",
		Long: `Check that Loom can load its configuration, secrets, and pricing rules.

The command prints the effective model prices after defaults and group ratios
have been applied. It does not start the service or connect to PostgreSQL.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg := config.MustGet()
			return app.CheckConfig(cfg, cmd.OutOrStdout())
		},
	}
}
