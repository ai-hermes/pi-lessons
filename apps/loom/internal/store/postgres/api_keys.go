package postgres

import (
	"context"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// GetAPIKeyByHash 见 store.Store。
func (d *DB) GetAPIKeyByHash(ctx context.Context, hash string) (store.APIKey, error) {
	row, err := d.q.GetKeyByHash(ctx, hash)
	return toAPIKey(row), d.fail("APIKeyByHash", err)
}

// GetAPIKey 见 store.Store。
func (d *DB) GetAPIKey(ctx context.Context, id uuid.UUID) (store.APIKey, error) {
	row, err := d.q.GetKey(ctx, id)
	return toAPIKey(sqlcgen.GetKeyByHashRow(row)), d.fail("APIKey", err)
}

// ListAPIKeys 见 store.Store。
func (d *DB) ListAPIKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]store.APIKey, error) {
	rows, err := d.q.ListKeys(ctx, sqlcgen.ListKeysParams{AccountID: accountID, Lim: queryLimit(limit)})
	if err != nil {
		return nil, d.fail("ListAPIKeys", err)
	}
	return mapRows(rows, func(r sqlcgen.ListKeysRow) store.APIKey { return toAPIKey(sqlcgen.GetKeyByHashRow(r)) }), nil
}

// CreateAPIKey 见 store.Store。
func (d *DB) CreateAPIKey(ctx context.Context, k store.APIKey) (store.APIKey, error) {
	row, err := d.q.CreateKey(ctx, sqlcgen.CreateKeyParams{
		ID:             k.ID,
		AccountID:      k.AccountID,
		Name:           k.Name,
		KeyHash:        k.KeyHash,
		KeyPreview:     k.KeyPreview,
		Status:         string(k.Status),
		ModelAllowlist: encodeAllowlist(k.ModelAllowlist),
		QuotaLimit:     k.QuotaLimit,
		ExpiresAt:      k.ExpiresAt,
	})
	if err != nil {
		return store.APIKey{}, d.fail("CreateAPIKey", err)
	}
	return d.GetAPIKey(ctx, row.ID)
}

// UpdateAPIKey 见 store.Store。
func (d *DB) UpdateAPIKey(ctx context.Context, id uuid.UUID, s store.APIKeySettings) (store.APIKey, error) {
	row, err := d.q.UpdateKey(ctx, sqlcgen.UpdateKeyParams{
		ID:             id,
		Name:           s.Name,
		Status:         string(s.Status),
		ModelAllowlist: encodeAllowlist(s.ModelAllowlist),
		QuotaLimit:     s.QuotaLimit,
		ExpiresAt:      s.ExpiresAt,
	})
	if err != nil {
		return store.APIKey{}, d.fail("UpdateAPIKey", err)
	}
	return d.GetAPIKey(ctx, row.ID)
}

// SetAPIKeyQuota 见 store.Store；与清空预扣在同一事务内完成。
func (d *DB) SetAPIKeyQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error {
	return d.inTx(ctx, "SetAPIKeyQuota", func(q *sqlcgen.Queries) error {
		if _, err := q.DeleteKeyReservations(ctx, id); err != nil {
			return d.fail("SetAPIKeyQuota.deleteReservations", err)
		}
		params := sqlcgen.SetKeyQuotaParams{ID: id, QuotaLimit: limit, QuotaUsed: used}
		err := q.SetKeyQuota(ctx, params)
		return d.fail("SetAPIKeyQuota", err)
	})
}
