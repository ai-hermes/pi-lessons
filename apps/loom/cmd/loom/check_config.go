package main

import (
	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
)

func newCheckConfigCmd(load configLoader) *cobra.Command {
	return &cobra.Command{
		Use:     "check-config",
		GroupID: "tooling",
		Short:   "Validate the config and print the effective price table",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := load()
			if err != nil {
				return err
			}
			return app.CheckConfig(cfg, cmd.OutOrStdout())
		},
	}
}
