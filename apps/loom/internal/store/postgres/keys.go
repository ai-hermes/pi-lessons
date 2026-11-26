package postgres

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// GetKeyByHash 见 store.Store。
func (d *DB) GetKeyByHash(ctx context.Context, hash string) (store.Key, error) {
	row, err := d.q.GetKeyByHash(ctx, hash)
	return toKey(row), d.fail("GetKeyByHash", err)
}

// GetKey 见 store.Store。
func (d *DB) GetKey(ctx context.Context, id uuid.UUID) (store.Key, error) {
	row, err := d.q.GetKey(ctx, id)
	return toKey(sqlcgen.GetKeyByHashRow(row)), d.fail("GetKey", err)
}

// ListKeys 见 store.Store。
func (d *DB) ListKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]store.Key, error) {
	rows, err := d.q.ListKeys(ctx, sqlcgen.ListKeysParams{AccountID: accountID, Lim: int32(limit)})
	if err != nil {
		return nil, d.fail("ListKeys", err)
	}
	return mapRows(rows, func(r sqlcgen.ListKeysRow) store.Key { return toKey(sqlcgen.GetKeyByHashRow(r)) }), nil
}

// CreateKey 见 store.Store。
func (d *DB) CreateKey(ctx context.Context, k store.Key, allowlist []string) (store.Key, error) {
	row, err := d.q.CreateKey(ctx, sqlcgen.CreateKeyParams{
		ID:             k.ID,
		AccountID:      k.AccountID,
		Name:           k.Name,
		KeyHash:        k.KeyHash,
		KeyPreview:     k.KeyPreview,
		Status:         string(k.Status),
		ModelAllowlist: encodeAllowlist(allowlist),
		QuotaLimit:     k.QuotaLimit,
		ExpiresAt:      k.ExpiresAt,
	})
	if err != nil {
		return store.Key{}, d.fail("CreateKey", err)
	}
	return d.GetKey(ctx, row.ID)
}

// UpdateKey 见 store.Store。
func (d *DB) UpdateKey(
	ctx context.Context,
	id uuid.UUID,
	status store.Status,
	allowlist []string,
	quotaLimit *int64,
	expiresAt *time.Time,
	name string,
) (store.Key, error) {
	row, err := d.q.UpdateKey(ctx, sqlcgen.UpdateKeyParams{
		ID:             id,
		Status:         string(status),
		ModelAllowlist: encodeAllowlist(allowlist),
		QuotaLimit:     quotaLimit,
		ExpiresAt:      expiresAt,
		Name:           name,
	})
	if err != nil {
		return store.Key{}, d.fail("UpdateKey", err)
	}
	return d.GetKey(ctx, row.ID)
}

// SetKeyQuota 见 store.Store；与清空预扣在同一事务内完成。
func (d *DB) SetKeyQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error {
	return d.inTx(ctx, "SetKeyQuota", func(q *sqlcgen.Queries) error {
		if _, err := q.DeleteKeyReservations(ctx, id); err != nil {
			return d.fail("SetKeyQuota.deleteReservations", err)
		}
		err := q.SetKeyQuota(ctx, sqlcgen.SetKeyQuotaParams{ID: id, QuotaLimit: limit, QuotaUsed: used})
		return d.fail("SetKeyQuota", err)
	})
}
