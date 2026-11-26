// Command loom 是 AgentGateway 的外挂鉴权与计费服务。
//
// 命令只做参数解析与依赖装配，业务逻辑在 internal/app。
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
)

// build 由 -ldflags 注入。
var (
	version = "dev"
	commit  = "none"
)

func main() {
	if err := newRoot().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "loom:", err)
		os.Exit(1)
	}
}

// newRoot 构建命令树；--config 对所有子命令生效。
func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:   "loom",
		Short: "extAuth + billing service for AgentGateway",
		Long: `loom is the external authentication (extAuth) and billing service for AgentGateway.
It admits requests against per-key and per-account quota, prices them from a
one-api style price table, and settles the actual token usage after the response.`,
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.SetVersionTemplate("loom {{.Version}} (" + commit + ")\n")

	var configPath string
	root.PersistentFlags().StringVar(&configPath, "config", "",
		"config.yaml (default: $LOOM_CONFIG, or ./config.yaml when present)")
	load := func() (*config.Config, error) { return loadConfig(configPath) }

	root.AddCommand(
		newServeCmd(load),
		newMigrateCmd(load),
		newSeedCmd(load),
		newRenderCatalogCmd(),
		newCheckConfigCmd(load),
		newVersionCmd(),
	)
	root.AddGroup(
		&cobra.Group{ID: "run", Title: "Running:"},
		&cobra.Group{ID: "ops", Title: "Operations:"},
		&cobra.Group{ID: "tooling", Title: "Tooling:"},
	)
	return root
}

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the build version",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, _ []string) {
			_, _ = fmt.Fprint(cmd.OutOrStdout(), "loom "+version+" ("+commit+")\n")
		},
	}
}

// loadConfig 依次使用 --config、$LOOM_CONFIG、./config.yaml（存在时）。
func loadConfig(path string) (*config.Config, error) {
	if path == "" {
		path = os.Getenv("LOOM_CONFIG")
	}
	if path == "" {
		if _, err := os.Stat("config.yaml"); err == nil {
			path = "config.yaml"
		}
	}
	return config.Load(path)
}

func printLines(cmd *cobra.Command, lines []string) {
	for _, line := range lines {
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), line)
	}
}
