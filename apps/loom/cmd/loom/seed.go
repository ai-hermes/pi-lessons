package main

import (
	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
)

func newSeedCmd(load configLoader) *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:     "seed",
		GroupID: "ops",
		Short:   "Idempotently seed accounts, API keys and pg fallback pricing",
		Long: `Seed accounts, API keys and pg fallback pricing from a YAML file.
Existing records are aligned with the file (by account name, and by key name within
an account); plaintext keys in the file are only for demo environments.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := load()
			if err != nil {
				return err
			}
			lines, err := app.Seed(cmd.Context(), cfg, file)
			printLines(cmd, lines)
			return err
		},
	}
	cmd.Flags().StringVar(&file, "file", "", "seed yaml file")
	_ = cmd.MarkFlagRequired("file")
	return cmd
}
