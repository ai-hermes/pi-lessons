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

// SetAPIKeyQuota 见 store.Store；清空预扣、修改额度与写入额度变更流水在同一事务内完成。
func (d *DB) SetAPIKeyQuota(ctx context.Context, id uuid.UUID, change store.QuotaChange) error {
	return d.inTx(ctx, "SetAPIKeyQuota", func(q *sqlcgen.Queries) error {
		before, err := q.LockKeyQuota(ctx, id)
		if err != nil {
			return d.fail("SetAPIKeyQuota.lock", err)
		}
		if _, err := q.DeleteKeyReservations(ctx, id); err != nil {
			return d.fail("SetAPIKeyQuota.deleteReservations", err)
		}
		params := sqlcgen.SetKeyQuotaParams{ID: id, QuotaLimit: change.LimitNanos, QuotaUsed: change.UsedNanos}
		if err := q.SetKeyQuota(ctx, params); err != nil {
			return d.fail("SetAPIKeyQuota", err)
		}
		return d.fail("SetAPIKeyQuota.adjustment", q.InsertQuotaAdjustment(ctx, sqlcgen.InsertQuotaAdjustmentParams{
			AccountID:   before.AccountID,
			KeyID:       &id,
			Kind:        string(store.QuotaReset),
			LimitBefore: before.QuotaLimit,
			LimitAfter:  change.LimitNanos,
			UsedBefore:  before.QuotaUsed,
			UsedAfter:   change.UsedNanos,
			Actor:       change.Actor,
		}))
	})
}
