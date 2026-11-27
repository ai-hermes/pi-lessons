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
	return toAccount(row), d.fail("Account", err)
}

// GetAccountByName 见 store.Store。
func (d *DB) GetAccountByName(ctx context.Context, name string) (store.Account, error) {
	row, err := d.q.GetAccountByName(ctx, name)
	return toAccount(row), d.fail("AccountByName", err)
}

// ListAccounts 见 store.Store。
func (d *DB) ListAccounts(ctx context.Context, limit int) ([]store.Account, error) {
	rows, err := d.q.ListAccounts(ctx, queryLimit(limit))
	if err != nil {
		return nil, d.fail("ListAccounts", err)
	}
	return mapRows(rows, toAccount), nil
}

// CreateAccount 见 store.Store。
func (d *DB) CreateAccount(ctx context.Context, a store.Account) (store.Account, error) {
	row, err := d.q.CreateAccount(ctx, sqlcgen.CreateAccountParams{
		ID:             a.ID,
		Name:           a.Name,
		Tenant:         a.Tenant,
		Group:          a.Group,
		Status:         string(a.Status),
		QuotaLimit:     a.QuotaLimit,
		Rpm:            a.Limits.RPM,
		Tpm:            a.Limits.TPM,
		MaxConcurrency: a.Limits.MaxConcurrency,
	})
	return toAccount(row), d.fail("CreateAccount", err)
}

// UpdateAccount 见 store.Store。
func (d *DB) UpdateAccount(ctx context.Context, id uuid.UUID, s store.AccountSettings) (store.Account, error) {
	row, err := d.q.UpdateAccount(ctx, sqlcgen.UpdateAccountParams{
		ID:             id,
		Status:         string(s.Status),
		Group:          s.Group,
		QuotaLimit:     s.QuotaLimit,
		Rpm:            s.Limits.RPM,
		Tpm:            s.Limits.TPM,
		MaxConcurrency: s.Limits.MaxConcurrency,
	})
	return toAccount(row), d.fail("UpdateAccount", err)
}

// AddAccountQuotaLimit 见 store.Store：锁行读取变更前的值，增加上限并写入额度变更流水。
func (d *DB) AddAccountQuotaLimit(
	ctx context.Context,
	id uuid.UUID,
	delta int64,
	actor string,
) (account store.Account, err error) {
	err = d.inTx(ctx, "AddAccountQuotaLimit", func(q *sqlcgen.Queries) error {
		before, err := q.LockAccountQuota(ctx, id)
		if err != nil {
			return d.fail("AddAccountQuotaLimit.lock", err)
		}
		params := sqlcgen.AddAccountQuotaLimitParams{ID: id, QuotaLimit: &delta}
		row, err := q.AddAccountQuotaLimit(ctx, params)
		if err != nil {
			return d.fail("AddAccountQuotaLimit", err)
		}
		account = toAccount(row)
		return d.fail("AddAccountQuotaLimit.adjustment", q.InsertQuotaAdjustment(ctx, sqlcgen.InsertQuotaAdjustmentParams{
			AccountID:   id,
			Kind:        string(store.QuotaTopUp),
			LimitBefore: before.QuotaLimit,
			LimitAfter:  account.QuotaLimit,
			UsedBefore:  before.QuotaUsed,
			UsedAfter:   account.QuotaUsed,
			Actor:       actor,
		}))
	})
	return account, err
}

// SetAccountQuota 见 store.Store；清空预扣、修改额度与写入额度变更流水在同一事务内完成。
func (d *DB) SetAccountQuota(ctx context.Context, id uuid.UUID, change store.QuotaChange) error {
	return d.inTx(ctx, "SetAccountQuota", func(q *sqlcgen.Queries) error {
		before, err := q.LockAccountQuota(ctx, id)
		if err != nil {
			return d.fail("SetAccountQuota.lock", err)
		}
		if err := q.DeleteAccountReservations(ctx, id); err != nil {
			return d.fail("SetAccountQuota.deleteReservations", err)
		}
		params := sqlcgen.SetAccountQuotaParams{ID: id, QuotaLimit: change.LimitNanos, QuotaUsed: change.UsedNanos}
		if err := q.SetAccountQuota(ctx, params); err != nil {
			return d.fail("SetAccountQuota", err)
		}
		return d.fail("SetAccountQuota.adjustment", q.InsertQuotaAdjustment(ctx, sqlcgen.InsertQuotaAdjustmentParams{
			AccountID:   id,
			Kind:        string(store.QuotaReset),
			LimitBefore: before.QuotaLimit,
			LimitAfter:  change.LimitNanos,
			UsedBefore:  before.QuotaUsed,
			UsedAfter:   change.UsedNanos,
			Actor:       change.Actor,
		}))
	})
}
