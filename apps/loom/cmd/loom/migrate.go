package main

import (
	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/postgres"
)

func newMigrateCmd() *cobra.Command {
	actions := []string{string(postgres.MigrateUp), string(postgres.MigrateDown), string(postgres.MigrateStatus)}
	return &cobra.Command{
		Use:     "migrate " + actions[0] + "|" + actions[1] + "|" + actions[2],
		GroupID: "ops",
		Annotations: map[string]string{
			requiresConfigAnnotation: "true",
		},
		Short: "Manage Loom's database schema",
		Long: `Apply, roll back, or inspect the database schema used by Loom.

  up      apply all pending schema changes
  down    roll back the most recent schema change
  status  show which schema changes have been applied`,
		Args:      cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
		ValidArgs: actions,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := config.MustGet()
			action := postgres.MigrationAction(args[0])
			lines, err := app.Migrate(cmd.Context(), cfg, action)
			printLines(cmd, lines)
			return err
		},
	}
}
