package postgres

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// 用量与审计。

// BackfillGatewayCost 见 store.Store。
func (d *DB) BackfillGatewayCost(ctx context.Context, requestID string, nanos int64) (bool, error) {
	n, err := d.q.BackfillGatewayCost(ctx, sqlcgen.BackfillGatewayCostParams{
		RequestID:        optionalText(requestID),
		GatewayCostNanos: &nanos,
	})
	return n > 0, d.fail("BackfillGatewayCost", err)
}

// ListUsage 见 store.Store。
func (d *DB) ListUsage(ctx context.Context, keyID *uuid.UUID, since *time.Time, limit int) ([]store.UsageEvent, error) {
	rows, err := d.q.ListUsage(ctx, sqlcgen.ListUsageParams{KeyID: keyID, Since: since, Lim: int32(limit)})
	if err != nil {
		return nil, d.fail("ListUsage", err)
	}
	return mapRows(rows, toUsageEvent), nil
}

// SummaryUsage 见 store.Store。
func (d *DB) SummaryUsage(ctx context.Context, f store.UsageFilter) ([]store.UsageSummaryRow, error) {
	params := sqlcgen.SummaryUsageParams{AccountID: f.AccountID, KeyID: f.KeyID, Since: f.Since}
	rows, err := d.q.SummaryUsage(ctx, params)
	if err != nil {
		return nil, d.fail("SummaryUsage", err)
	}
	return mapRows(rows, func(r sqlcgen.SummaryUsageRow) store.UsageSummaryRow {
		row := store.UsageSummaryRow{
			Model:            r.Model,
			Requests:         r.Requests,
			InputTokens:      r.InputTokens,
			OutputTokens:     r.OutputTokens,
			CachedTokens:     r.CachedTokens,
			CostNanos:        r.CostNanos,
			GatewayCostNanos: r.GatewayCostNanos,
		}
		if r.AccountID != nil {
			row.AccountID = *r.AccountID
		}
		if r.KeyID != nil {
			row.KeyID = *r.KeyID
		}
		return row
	}), nil
}

const insertAuditSQL = `INSERT INTO auth_audit
	(time, request_id, client_request_id, key_id, account_id, protocol, model, allowed, reason)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

// InsertAudit 见 store.Store：一次往返批量写入。
func (d *DB) InsertAudit(ctx context.Context, rows []store.Audit) error {
	if len(rows) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(insertAuditSQL,
			r.Time, r.RequestID, r.ClientRequestID, r.KeyID, r.AccountID, r.Protocol, r.Model, r.Allowed, r.Reason)
	}
	results := d.pool.SendBatch(ctx, batch)
	defer func() { _ = results.Close() }()
	for range rows {
		if _, err := results.Exec(); err != nil {
			return d.fail("InsertAudit", err)
		}
	}
	return nil
}

// ListAudit 见 store.Store。
func (d *DB) ListAudit(ctx context.Context, keyID *uuid.UUID, limit int) ([]store.Audit, error) {
	rows, err := d.q.ListAudit(ctx, sqlcgen.ListAuditParams{KeyID: keyID, Lim: int32(limit)})
	if err != nil {
		return nil, d.fail("ListAudit", err)
	}
	return mapRows(rows, toAudit), nil
}
