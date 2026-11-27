package postgres

import (
	"context"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// 额度变更流水与管理面。

// ListQuotaAdjustments 见 store.Store。
func (d *DB) ListQuotaAdjustments(
	ctx context.Context,
	f store.QuotaAdjustmentFilter,
	limit int,
) ([]store.QuotaAdjustment, error) {
	params := sqlcgen.ListQuotaAdjustmentsParams{AccountID: f.AccountID, KeyID: f.APIKeyID, Lim: queryLimit(limit)}
	rows, err := d.q.ListQuotaAdjustments(ctx, params)
	if err != nil {
		return nil, d.fail("ListQuotaAdjustments", err)
	}
	return mapRows(rows, toQuotaAdjustment), nil
}

// CreateAdminToken 见 store.Store。
func (d *DB) CreateAdminToken(ctx context.Context, t store.AdminToken) (store.AdminToken, error) {
	row, err := d.q.CreateAdminToken(ctx, sqlcgen.CreateAdminTokenParams{
		ID:           t.ID,
		Name:         t.Name,
		TokenHash:    t.TokenHash,
		TokenPreview: t.TokenPreview,
		Role:         t.Role,
	})
	return toAdminToken(row), d.fail("CreateAdminToken", err)
}

// GetAdminTokenByHash 见 store.Store。
func (d *DB) GetAdminTokenByHash(ctx context.Context, hash string) (store.AdminToken, error) {
	row, err := d.q.GetAdminTokenByHash(ctx, hash)
	return toAdminToken(row), d.fail("GetAdminTokenByHash", err)
}

// ListAdminTokens 见 store.Store。
func (d *DB) ListAdminTokens(ctx context.Context) ([]store.AdminToken, error) {
	rows, err := d.q.ListAdminTokens(ctx)
	if err != nil {
		return nil, d.fail("ListAdminTokens", err)
	}
	return mapRows(rows, toAdminToken), nil
}

// RevokeAdminToken 见 store.Store。
func (d *DB) RevokeAdminToken(ctx context.Context, id uuid.UUID) error {
	n, err := d.q.RevokeAdminToken(ctx, id)
	if err != nil {
		return d.fail("RevokeAdminToken", err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// InsertAdminAudit 见 store.Store。
func (d *DB) InsertAdminAudit(ctx context.Context, row store.AdminAudit) error {
	return d.fail("InsertAdminAudit", d.q.InsertAdminAudit(ctx, sqlcgen.InsertAdminAuditParams{
		Actor:   row.Actor,
		Method:  row.Method,
		Route:   row.Route,
		Target:  row.Target,
		Request: row.Request,
		Status:  httpStatus(row.Status),
	}))
}

// ListAdminAudit 见 store.Store。
func (d *DB) ListAdminAudit(ctx context.Context, limit int) ([]store.AdminAudit, error) {
	rows, err := d.q.ListAdminAudit(ctx, queryLimit(limit))
	if err != nil {
		return nil, d.fail("ListAdminAudit", err)
	}
	return mapRows(rows, toAdminAudit), nil
}

func toQuotaAdjustment(r sqlcgen.QuotaAdjustment) store.QuotaAdjustment {
	return store.QuotaAdjustment{
		ID:          r.ID,
		Time:        r.Time,
		AccountID:   r.AccountID,
		APIKeyID:    r.KeyID,
		Kind:        store.QuotaAdjustmentKind(r.Kind),
		LimitBefore: r.LimitBefore,
		LimitAfter:  r.LimitAfter,
		UsedBefore:  r.UsedBefore,
		UsedAfter:   r.UsedAfter,
		Actor:       r.Actor,
	}
}

func toAdminToken(r sqlcgen.AdminToken) store.AdminToken {
	return store.AdminToken{
		ID:           r.ID,
		Name:         r.Name,
		TokenHash:    r.TokenHash,
		TokenPreview: r.TokenPreview,
		Role:         r.Role,
		CreatedAt:    r.CreatedAt,
		RevokedAt:    r.RevokedAt,
	}
}

func toAdminAudit(r sqlcgen.AdminAudit) store.AdminAudit {
	return store.AdminAudit{
		ID:      r.ID,
		Time:    r.Time,
		Actor:   r.Actor,
		Method:  r.Method,
		Route:   r.Route,
		Target:  r.Target,
		Request: r.Request,
		Status:  int(r.Status),
	}
}

// httpStatus 把 HTTP 状态码收敛到 int32；合法状态码只有三位数。
func httpStatus(status int) int32 {
	if status < 0 || status > 999 {
		return 0
	}
	return int32(status)
}
