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
		Short:   "Render the agentgateway modelCatalog from pricing.yaml",
		Long: `Render pricing.yaml into the catalog.json format understood by agentgateway's
modelCatalog (rates in USD per 1M tokens). Per-call models and group ratios cannot
be expressed in the gateway catalog and are skipped.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if out == "" {
				return app.RenderGatewayCatalog(pricingFile, cmd.OutOrStdout())
			}
			f, err := os.Create(out)
			if err != nil {
				return err
			}
			if err := app.RenderGatewayCatalog(pricingFile, f); err != nil {
				_ = f.Close()
				return err
			}
			return f.Close()
		},
	}
	cmd.Flags().StringVar(&pricingFile, "pricing", "", "pricing.yaml")
	cmd.Flags().StringVar(&out, "out", "", "output file (default stdout)")
	_ = cmd.MarkFlagRequired("pricing")
	return cmd
}
