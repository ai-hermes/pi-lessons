// Package postgres 是 store.Store 的 PostgreSQL 实现，查询由 sqlc 生成（internal/store/sqlcgen）。
package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

var _ store.Store = (*DB)(nil)

const pingTimeout = 10 * time.Second

// Options 连接池参数。
type Options struct {
	DSN              string
	MinConns         int32
	MaxConns         int32
	MaxConnLifetime  time.Duration
	StatementTimeout time.Duration
}

// DB 封装连接池与 sqlc 查询。
type DB struct {
	pool    *pgxpool.Pool
	conn    *pgx.ConnConfig
	q       *sqlcgen.Queries
	onError func(op string, err error)
}

// New 创建连接池并确认可连通。
func New(ctx context.Context, opts Options) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(opts.DSN)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MinConns = opts.MinConns
	cfg.MaxConns = opts.MaxConns
	cfg.MaxConnLifetime = opts.MaxConnLifetime
	if opts.StatementTimeout > 0 {
		cfg.ConnConfig.RuntimeParams["statement_timeout"] = fmt.Sprint(opts.StatementTimeout.Milliseconds())
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &DB{pool: pool, conn: cfg.ConnConfig, q: sqlcgen.New(pool)}, nil
}

// SetErrorHandler 设置非预期错误的回调（用于指标）；未找到、唯一冲突不会回调。
func (d *DB) SetErrorHandler(fn func(op string, err error)) { d.onError = fn }

// Ping 检查数据库连通性。
func (d *DB) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }

// Stat 返回连接池实时统计。
func (d *DB) Stat() *pgxpool.Stat { return d.pool.Stat() }

// Close 关闭连接池。
func (d *DB) Close() { d.pool.Close() }

// fail 把驱动错误翻译为 store 哨兵错误，其余错误补充操作名并上报。
func (d *DB) fail(op string, err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, pgx.ErrNoRows):
		return store.ErrNotFound
	case isUniqueViolation(err):
		return fmt.Errorf("%s: %w", op, store.ErrConflict)
	}
	if d.onError != nil {
		d.onError(op, err)
	}
	return fmt.Errorf("%s: %w", op, err)
}

// inTx 在一个事务中执行 fn；fn 返回错误时回滚。
func (d *DB) inTx(ctx context.Context, op string, fn func(q *sqlcgen.Queries) error) error {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return d.fail(op+".begin", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := fn(d.q.WithTx(tx)); err != nil {
		return err
	}
	return d.fail(op+".commit", tx.Commit(ctx))
}

// isUniqueViolation 判断是否唯一约束冲突（SQLSTATE 23505）。
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
