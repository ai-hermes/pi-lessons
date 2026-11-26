package postgres

import (
	"context"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// GetAccount 见 store.Store。
func (d *DB) GetAccount(ctx context.Context, id uuid.UUID) (store.Account, error) {
	row, err := d.q.GetAccount(ctx, id)
	return toAccount(row), d.fail("GetAccount", err)
}

// GetAccountByName 见 store.Store。
func (d *DB) GetAccountByName(ctx context.Context, name string) (store.Account, error) {
	row, err := d.q.GetAccountByName(ctx, name)
	return toAccount(row), d.fail("GetAccountByName", err)
}

// ListAccounts 见 store.Store。
func (d *DB) ListAccounts(ctx context.Context, limit int) ([]store.Account, error) {
	rows, err := d.q.ListAccounts(ctx, int32(limit))
	if err != nil {
		return nil, d.fail("ListAccounts", err)
	}
	return mapRows(rows, toAccount), nil
}

// CreateAccount 见 store.Store。
func (d *DB) CreateAccount(ctx context.Context, a store.Account) (store.Account, error) {
	row, err := d.q.CreateAccount(ctx, sqlcgen.CreateAccountParams{
		ID:         a.ID,
		Name:       a.Name,
		Tenant:     a.Tenant,
		Group:      a.Group,
		Status:     string(a.Status),
		QuotaLimit: a.QuotaLimit,
	})
	return toAccount(row), d.fail("CreateAccount", err)
}

// UpdateAccount 见 store.Store。
func (d *DB) UpdateAccount(
	ctx context.Context,
	id uuid.UUID,
	status store.Status,
	quotaLimit *int64,
	group string,
) (store.Account, error) {
	row, err := d.q.UpdateAccount(ctx, sqlcgen.UpdateAccountParams{
		ID:         id,
		Status:     string(status),
		QuotaLimit: quotaLimit,
		Group:      group,
	})
	return toAccount(row), d.fail("UpdateAccount", err)
}

// AddAccountQuotaLimit 见 store.Store。
func (d *DB) AddAccountQuotaLimit(ctx context.Context, id uuid.UUID, delta int64) (store.Account, error) {
	row, err := d.q.AddAccountQuotaLimit(ctx, sqlcgen.AddAccountQuotaLimitParams{ID: id, QuotaLimit: &delta})
	return toAccount(row), d.fail("AddAccountQuotaLimit", err)
}

// SetAccountQuota 见 store.Store；与清空预扣在同一事务内完成。
func (d *DB) SetAccountQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error {
	return d.inTx(ctx, "SetAccountQuota", func(q *sqlcgen.Queries) error {
		if _, err := q.DeleteAccountReservations(ctx, id); err != nil {
			return d.fail("SetAccountQuota.deleteReservations", err)
		}
		err := q.SetAccountQuota(ctx, sqlcgen.SetAccountQuotaParams{ID: id, QuotaLimit: limit, QuotaUsed: used})
		return d.fail("SetAccountQuota", err)
	})
}
