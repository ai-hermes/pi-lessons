package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/migrations"
)

// migrationLockID 是迁移使用的 PG advisory lock 键（任意固定值），
// 多副本同时启动时串行执行迁移，避免第二个副本因表已存在而失败。
const migrationLockID int64 = 0x1000_0001

// MigrationAction goose 迁移动作。
type MigrationAction string

// 支持的迁移动作。
const (
	MigrateUp     MigrationAction = "up"
	MigrateDown   MigrationAction = "down"
	MigrateStatus MigrationAction = "status"
)

// Migrate 在 advisory lock 保护下执行嵌入的 goose 迁移，返回每个迁移文件的结果摘要。
func (d *DB) Migrate(ctx context.Context, action MigrationAction) ([]string, error) {
	conn, err := d.pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLockID); err != nil {
		return nil, fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", migrationLockID) }()

	provider, err := goose.NewProvider(goose.DialectPostgres, stdlib.OpenDB(*d.conn), migrations.FS)
	if err != nil {
		return nil, fmt.Errorf("init migrations: %w", err)
	}
	defer func() { _ = provider.Close() }()

	var lines []string
	switch action {
	case MigrateUp, MigrateDown:
		var results []*goose.MigrationResult
		if action == MigrateUp {
			results, err = provider.Up(ctx)
		} else {
			var r *goose.MigrationResult
			if r, err = provider.Down(ctx); r != nil {
				results = append(results, r)
			}
		}
		for _, r := range results {
			lines = append(lines, fmt.Sprintf("%s %s (%s)", action, r.Source.Path, r.Duration))
		}
	case MigrateStatus:
		var statuses []*goose.MigrationStatus
		statuses, err = provider.Status(ctx)
		for _, st := range statuses {
			lines = append(lines, fmt.Sprintf("%-8s %s", st.State, st.Source.Path))
		}
	default:
		return nil, fmt.Errorf("unknown migration action %q", action)
	}
	if err != nil {
		return nil, fmt.Errorf("migrate %s: %w", action, err)
	}
	return lines, nil
}
