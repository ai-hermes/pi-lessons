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

const requiresConfigAnnotation = "loom.requires-config"

func main() {
	if err := newRoot().Execute(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "loom:", err)
		os.Exit(1)
	}
}

// newRoot 构建命令树；--config 对所有子命令生效。
func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:   "loom",
		Short: "Add authentication and usage billing to AgentGateway",
		Long: `Loom adds authentication, quota control, and usage billing to AgentGateway.

It provides extAuth and billing services that validate API keys, enforce account
and key quotas, price model usage, and settle the actual cost of each request.`,
		Version:           version,
		SilenceUsage:      true,
		SilenceErrors:     true,
		PersistentPreRunE: prepareCommand,
	}
	root.SetVersionTemplate("loom {{.Version}} (" + commit + ")\n")

	root.PersistentFlags().String(
		"config",
		"",
		"path to the Loom config file ($LOOM_CONFIG or ./config.yaml if unset)",
	)

	root.AddGroup(
		&cobra.Group{ID: "run", Title: "Service:"},
		&cobra.Group{ID: "ops", Title: "Administration:"},
		&cobra.Group{ID: "tooling", Title: "Utilities:"},
	)
	root.AddCommand(
		newServeCmd(),
		newMigrateCmd(),
		newSeedCmd(),
		newRenderCatalogCmd(),
		newCheckConfigCmd(),
		newVersionCmd(),
	)
	return root
}

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Show the installed Loom version",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, _ []string) {
			_, _ = fmt.Fprint(cmd.OutOrStdout(), "loom "+version+" ("+commit+")\n")
		},
	}
}

// prepareCommand 编排所有子命令执行前的公共准备工作。
func prepareCommand(cmd *cobra.Command, args []string) error {
	if err := initializeConfig(cmd, args); err != nil {
		return err
	}
	return nil
}

// initializeConfig 仅初始化显式声明需要 Loom 运行配置的子命令。
func initializeConfig(cmd *cobra.Command, _ []string) error {
	if cmd.Annotations[requiresConfigAnnotation] != "true" {
		return nil
	}

	// Cobra 默认在 PersistentPreRunE 之后检查 required flags；这里提前检查，
	// 避免缺少业务参数时被配置错误掩盖。
	if err := cmd.ValidateRequiredFlags(); err != nil {
		return err
	}
	if err := cmd.ValidateFlagGroups(); err != nil {
		return err
	}

	path, err := cmd.Flags().GetString("config")
	if err != nil {
		return err
	}
	_, err = config.Init(path)
	return err
}

func printLines(cmd *cobra.Command, lines []string) {
	for _, line := range lines {
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), line)
	}
}
