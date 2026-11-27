package main

import (
	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
)

func newSeedCmd() *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:     "seed",
		GroupID: "ops",
		Annotations: map[string]string{
			requiresConfigAnnotation: "true",
		},
		Short: "Load initial accounts, API keys, and fallback prices",
		Long: `Load Loom's initial accounts, API keys, quotas, and fallback model prices from YAML.

The command is safe to run repeatedly: existing accounts and keys are updated to
match the file. Plaintext API keys should only be used in demo environments.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg := config.MustGet()
			lines, err := app.Seed(cmd.Context(), cfg, file)
			printLines(cmd, lines)
			return err
		},
	}
	cmd.Flags().StringVar(&file, "file", "", "path to the seed YAML file")
	_ = cmd.MarkFlagRequired("file")
	return cmd
}
