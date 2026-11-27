package postgres_test

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/postgres"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/storetest"
)

// TestConformance 在真实 PostgreSQL 上运行 store 一致性用例；需要 LOOM_TEST_PG_DSN（见 deploy/conformance.sh）。
func TestConformance(t *testing.T) {
	dsn := os.Getenv("LOOM_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("set LOOM_TEST_PG_DSN to run the store conformance suite against PostgreSQL")
	}
	ctx := context.Background()
	db, err := postgres.New(ctx, postgres.Options{DSN: dsn, MinConns: 1, MaxConns: 4})
	require.NoError(t, err)
	t.Cleanup(db.Close)
	_, err = db.Migrate(ctx, postgres.MigrateUp)
	require.NoError(t, err)

	storetest.Run(t, func(*testing.T) store.Store { return db })
}
