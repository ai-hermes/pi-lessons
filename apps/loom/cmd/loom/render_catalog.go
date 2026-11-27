package main

import (
	"os"

	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
)

func newRenderCatalogCmd() *cobra.Command {
	var pricingFile, out string
	cmd := &cobra.Command{
		Use:     "render-catalog",
		GroupID: "tooling",
		Short:   "Generate an AgentGateway model catalog from Loom pricing",
		Long: `Convert Loom's pricing rules into a model catalog that AgentGateway can load.

Token rates are written in USD per one million tokens. Models priced per request
and account-group price adjustments are Loom-only features and are not included.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if out == "" {
				return app.RenderAgentGatewayCatalog(pricingFile, cmd.OutOrStdout())
			}
			f, err := os.Create(out) //nolint:gosec // Output path is explicitly supplied by the CLI operator.
			if err != nil {
				return err
			}
			if err := app.RenderAgentGatewayCatalog(pricingFile, f); err != nil {
				_ = f.Close()
				return err
			}
			return f.Close()
		},
	}
	cmd.Flags().StringVar(&pricingFile, "pricing", "", "path to Loom pricing.yaml")
	cmd.Flags().StringVar(&out, "out", "", "write the catalog to this file (default: stdout)")
	_ = cmd.MarkFlagRequired("pricing")
	return cmd
}
