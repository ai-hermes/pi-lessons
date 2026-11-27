package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// execute 运行命令并返回 stdout、stderr 与错误。
func execute(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	root := newRoot()
	var stdout, stderr bytes.Buffer
	root.SetOut(&stdout)
	root.SetErr(&stderr)
	root.SetArgs(args)
	err := root.Execute()
	return stdout.String(), stderr.String(), err
}

func TestRootHelpListsCommands(t *testing.T) {
	stdout, _, err := execute(t, "--help")

	require.NoError(t, err)
	for _, name := range []string{"serve", "migrate", "seed", "render-catalog", "check-config", "completion"} {
		assert.Contains(t, stdout, name)
	}
	assert.Contains(t, stdout, "Loom adds authentication, quota control, and usage billing to AgentGateway")
	assert.Contains(t, stdout, "Service:")
	assert.Contains(t, stdout, "Administration:")
	assert.Contains(t, stdout, "Utilities:")
}

func TestVersion(t *testing.T) {
	stdout, _, err := execute(t, "version")

	require.NoError(t, err)
	assert.Contains(t, stdout, "loom "+version+" ("+commit+")")
}

func TestVersionDoesNotLoadServiceConfig(t *testing.T) {
	t.Setenv("LOOM_CONFIG", filepath.Join(t.TempDir(), "missing.yaml"))

	stdout, _, err := execute(t, "version")

	require.NoError(t, err)
	assert.Contains(t, stdout, "loom "+version)
}

func TestMigrateValidatesAction(t *testing.T) {
	_, _, err := execute(t, "migrate", "sideways")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid argument")
}

func TestSeedRequiresFile(t *testing.T) {
	// 根命令 SilenceErrors：错误由 main 统一打印，这里只断言返回值
	_, _, err := execute(t, "seed")

	require.Error(t, err)
	assert.Contains(t, err.Error(), `required flag(s) "file" not set`)
}

func TestCommandsRejectPositionalArgs(t *testing.T) {
	for _, cmd := range []string{"serve", "seed", "render-catalog", "check-config"} {
		_, _, err := execute(t, cmd, "unexpected", "--file", "x", "--pricing", "y")
		assert.Error(t, err, cmd)
	}
}

func TestRenderCatalog(t *testing.T) {
	dir := t.TempDir()
	pricing := filepath.Join(dir, "pricing.yaml")
	priceConfig := "models:\n  lab-model: {model_ratio: 0.5, completion_ratio: 2}\n"
	require.NoError(t, os.WriteFile(pricing, []byte(priceConfig), 0o600))
	out := filepath.Join(dir, "catalog.json")

	_, _, err := execute(t, "render-catalog", "--pricing", pricing, "--out", out)

	require.NoError(t, err)
	b, err := os.ReadFile(out) //nolint:gosec // out is a test-owned path under t.TempDir().
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(string(b), "{\n  \"providers\""))
	assert.Contains(t, string(b), `"input": "1"`)
}
