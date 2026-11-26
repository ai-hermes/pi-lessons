package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEnvKey(t *testing.T) {
	tests := []struct {
		env      string
		expected string
	}{
		{env: "LOOM_LOG_LEVEL", expected: "log.level"},
		{env: "LOOM_SERVER_OPS_LISTEN", expected: "server.ops_listen"},
		{env: "LOOM_SERVER_SHUTDOWN_TIMEOUT", expected: "server.shutdown_timeout"},
		{env: "LOOM_POSTGRES_DSN", expected: "postgres.dsn"},
		{env: "LOOM_LEDGER__RESERVE_TOKENS__INPUT", expected: "ledger.reserve_tokens.input"},
	}
	for _, tt := range tests {
		t.Run(tt.env, func(t *testing.T) {
			assert.Equal(t, tt.expected, envKey(tt.env))
		})
	}
}

func TestLoadAppliesEnvOverrides(t *testing.T) {
	t.Setenv("LOOM_POSTGRES_DSN", "postgres://x")
	t.Setenv("LOOM_ADMIN_TOKEN", "t")
	t.Setenv("LOOM_SERVER_OPS_LISTEN", ":19090")
	t.Setenv("LOOM_LEDGER__RESERVE_TOKENS__INPUT", "512")

	cfg, err := Load("")

	require.NoError(t, err)
	assert.Equal(t, ":19090", cfg.Server.OpsListen)
	assert.Equal(t, int64(512), cfg.Ledger.ReserveTokens.Input)
	assert.Equal(t, int64(1024), cfg.Ledger.ReserveTokens.Output)
}

func TestLoadRejectsMissingSecrets(t *testing.T) {
	_, err := Load("")
	assert.ErrorContains(t, err, "postgres.dsn")
	assert.ErrorContains(t, err, "admin.token")
}

func TestShippedConfigIsValid(t *testing.T) {
	dir := t.TempDir()
	dsn := filepath.Join(dir, "dsn")
	token := filepath.Join(dir, "token")
	require.NoError(t, os.WriteFile(dsn, []byte("postgres://x\n"), 0o600))
	require.NoError(t, os.WriteFile(token, []byte("t\n"), 0o600))
	t.Setenv("LOOM_POSTGRES_DSN_FILE", dsn)
	t.Setenv("LOOM_ADMIN_TOKEN_FILE", token)

	cfg, err := Load("../../configs/config.yaml")

	require.NoError(t, err)
	assert.Equal(t, ":8080", cfg.Server.Listen)
	assert.Equal(t, 403, cfg.ExtAuth.DenyStatus["insufficient_quota"])
}
