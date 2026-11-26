package main

import (
	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/app"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/postgres"
)

func newMigrateCmd(load configLoader) *cobra.Command {
	var actions = []string{string(postgres.MigrateUp), string(postgres.MigrateDown), string(postgres.MigrateStatus)}
	return &cobra.Command{
		Use:     "migrate " + actions[0] + "|" + actions[1] + "|" + actions[2],
		GroupID: "ops",
		Short:   "Run database migrations",
		Long: `Run the embedded goose migrations.
  up      apply all pending migrations
  down    roll back the last migration
  status  list migrations and their state`,
		Args:      cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
		ValidArgs: actions,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := load()
			if err != nil {
				return err
			}
			lines, err := app.Migrate(cmd.Context(), cfg, postgres.MigrationAction(args[0]))
			printLines(cmd, lines)
			return err
		},
	}
}
