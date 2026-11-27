package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// invalidationChannel 是跨副本缓存失效使用的 LISTEN / NOTIFY 频道。
const invalidationChannel = "loom_invalidate"

// PublishInvalidation 广播一条缓存失效消息；在连接池上执行，可经过事务模式的连接池。
func (d *DB) PublishInvalidation(ctx context.Context, payload string) error {
	_, err := d.pool.Exec(ctx, "SELECT pg_notify($1, $2)", invalidationChannel, payload)
	return d.fail("PublishInvalidation", err)
}

// ListenInvalidations 在一条独立连接上 LISTEN，阻塞接收消息直到 ctx 结束或连接出错。
// LISTEN 需要会话级连接，不能经过事务模式的连接池；此时用 postgres.listen_dsn 指向可直连的地址。
func (d *DB) ListenInvalidations(ctx context.Context, handle func(payload string)) error {
	conn, err := pgx.ConnectConfig(ctx, d.listenConfig.Copy())
	if err != nil {
		return fmt.Errorf("connect listener: %w", err)
	}
	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()

	if _, err := conn.Exec(ctx, "LISTEN "+invalidationChannel); err != nil {
		return fmt.Errorf("listen %s: %w", invalidationChannel, err)
	}
	for {
		notification, err := conn.WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait for notification: %w", err)
		}
		handle(notification.Payload)
	}
}
