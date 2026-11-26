// Package pg 是 store.Store 的 PostgreSQL 实现，基于 sqlc 生成的查询。
package pg

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// DB 封装连接池与 sqlc Queries。
type DB struct {
	pool  *pgxpool.Pool
	conn  *pgx.ConnConfig
	q     *sqlcgen.Queries
	onErr func(op string, err error)
}

// New 创建连接池并 Ping。
func New(ctx context.Context, dsn string, minConns, maxConns int32, lifetime, stmtTimeout time.Duration) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MinConns = minConns
	cfg.MaxConns = maxConns
	cfg.MaxConnLifetime = lifetime
	if stmtTimeout > 0 {
		cfg.ConnConfig.RuntimeParams["statement_timeout"] = fmt.Sprintf("%d", stmtTimeout.Milliseconds())
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &DB{pool: pool, conn: cfg.ConnConfig, q: sqlcgen.New(pool)}, nil
}

// SetErrorHandler 设置指标回调。
func (d *DB) SetErrorHandler(fn func(op string, err error)) { d.onErr = fn }

func (d *DB) fail(op string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return loom.ErrNotFound
	}
	if d.onErr != nil {
		d.onErr(op, err)
	}
	return err
}

// SQL 返回 database/sql 句柄（独立连接池），供 goose CLI 使用；调用方负责 Close。
func (d *DB) SQL() *sql.DB { return stdlib.OpenDB(*d.conn) }

// Migrate 用 goose 执行嵌入的迁移。
func (d *DB) Migrate(ctx context.Context, migrationsFS fs.FS, dir string) error {
	goose.SetBaseFS(migrationsFS)
	defer goose.SetBaseFS(nil)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	sdb := d.SQL()
	defer sdb.Close()
	return goose.UpContext(ctx, sdb, dir)
}

// Ping 检查数据库连通性。
func (d *DB) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }

// Pool 底层连接池。
func (d *DB) Pool() *pgxpool.Pool { return d.pool }

func (d *DB) Close() error {
	d.pool.Close()
	return nil
}

// ---- accounts ----

func toAccount(a sqlcgen.Account) store.Account {
	return store.Account{ID: a.ID, Name: a.Name, Tenant: a.Tenant, Group: a.Group, Status: a.Status,
		QuotaLimit: a.QuotaLimit, QuotaUsed: a.QuotaUsed, Reserved: a.Reserved, CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt}
}

func (d *DB) GetAccount(ctx context.Context, id uuid.UUID) (store.Account, error) {
	a, err := d.q.GetAccount(ctx, id)
	return toAccount(a), d.fail("GetAccount", err)
}

func (d *DB) GetAccountByName(ctx context.Context, name string) (store.Account, error) {
	a, err := d.q.GetAccountByName(ctx, name)
	return toAccount(a), d.fail("GetAccountByName", err)
}

func (d *DB) ListAccounts(ctx context.Context, limit int) ([]store.Account, error) {
	rows, err := d.q.ListAccounts(ctx, int32(limit))
	if err != nil {
		return nil, d.fail("ListAccounts", err)
	}
	out := make([]store.Account, 0, len(rows))
	for _, r := range rows {
		out = append(out, toAccount(r))
	}
	return out, nil
}

func (d *DB) CreateAccount(ctx context.Context, a store.Account) (store.Account, error) {
	row, err := d.q.CreateAccount(ctx, sqlcgen.CreateAccountParams{ID: a.ID, Name: a.Name, Tenant: a.Tenant,
		Group: a.Group, Status: a.Status, QuotaLimit: a.QuotaLimit})
	if err != nil {
		return store.Account{}, d.fail("CreateAccount", err)
	}
	return toAccount(row), nil
}

func (d *DB) UpdateAccount(ctx context.Context, id uuid.UUID, status string, quotaLimit *int64, group string) (store.Account, error) {
	row, err := d.q.UpdateAccount(ctx, sqlcgen.UpdateAccountParams{ID: id, Status: status, QuotaLimit: quotaLimit, Group: group})
	if err != nil {
		return store.Account{}, d.fail("UpdateAccount", err)
	}
	return toAccount(row), nil
}

func (d *DB) AddAccountQuotaLimit(ctx context.Context, id uuid.UUID, delta int64) (store.Account, error) {
	row, err := d.q.AddAccountQuotaLimit(ctx, sqlcgen.AddAccountQuotaLimitParams{ID: id, QuotaLimit: &delta})
	if err != nil {
		return store.Account{}, d.fail("AddAccountQuotaLimit", err)
	}
	return toAccount(row), nil
}

// SetAccountQuota 见 store.Store。
func (d *DB) SetAccountQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error {
	if _, err := d.q.DeleteAccountReservations(ctx, id); err != nil {
		return d.fail("DeleteAccountReservations", err)
	}
	return d.fail("SetAccountQuota", d.q.SetAccountQuota(ctx, sqlcgen.SetAccountQuotaParams{ID: id, QuotaLimit: limit, QuotaUsed: used}))
}

// SetKeyQuota 见 store.Store。
func (d *DB) SetKeyQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error {
	if _, err := d.q.DeleteKeyReservations(ctx, id); err != nil {
		return d.fail("DeleteKeyReservations", err)
	}
	return d.fail("SetKeyQuota", d.q.SetKeyQuota(ctx, sqlcgen.SetKeyQuotaParams{ID: id, QuotaLimit: limit, QuotaUsed: used}))
}

func toQuota(limit *int64, used, reserved int64) store.QuotaState {
	return store.QuotaState{Limit: limit, Used: used, Reserved: reserved}
}

func (d *DB) ReserveAccountQuota(ctx context.Context, id uuid.UUID, nanos int64) (store.QuotaState, error) {
	if nanos <= 0 {
		a, err := d.GetAccount(ctx, id)
		return store.QuotaState{Limit: a.QuotaLimit, Used: a.QuotaUsed, Reserved: a.Reserved}, err
	}
	q, err := d.q.ReserveAccountQuota(ctx, sqlcgen.ReserveAccountQuotaParams{ID: id, Reserved: nanos})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.QuotaState{}, loom.ErrInsufficientQuota
	}
	return toQuota(q.QuotaLimit, q.QuotaUsed, q.Reserved), d.fail("ReserveAccountQuota", err)
}

func (d *DB) ReleaseAccountReservation(ctx context.Context, id uuid.UUID, nanos int64) error {
	if nanos <= 0 {
		return nil
	}
	return d.fail("ReleaseAccountReservation", d.q.ReleaseAccountReservation(ctx, sqlcgen.ReleaseAccountReservationParams{ID: id, Reserved: nanos}))
}

// ---- keys ----

// listRowToHashRow 把 ListKeysRow 转换为 GetKeyByHashRow。
func listRowToHashRow(r sqlcgen.ListKeysRow) sqlcgen.GetKeyByHashRow {
	return sqlcgen.GetKeyByHashRow{ID: r.ID, AccountID: r.AccountID, Name: r.Name, KeyHash: r.KeyHash, KeyPreview: r.KeyPreview,
		Status: r.Status, ModelAllowlist: r.ModelAllowlist, QuotaLimit: r.QuotaLimit, QuotaUsed: r.QuotaUsed, Reserved: r.Reserved,
		ExpiresAt: r.ExpiresAt, LastUsedAt: r.LastUsedAt, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		AccountName: r.AccountName, AccountTenant: r.AccountTenant, AccountGroup: r.AccountGroup, AccountStatus: r.AccountStatus,
		AccountQuotaLimit: r.AccountQuotaLimit, AccountQuotaUsed: r.AccountQuotaUsed, AccountReserved: r.AccountReserved}
}

// rowToHashRow 把 GetKeyRow 转换为 GetKeyByHashRow。
func rowToHashRow(r sqlcgen.GetKeyRow) sqlcgen.GetKeyByHashRow {
	return sqlcgen.GetKeyByHashRow{ID: r.ID, AccountID: r.AccountID, Name: r.Name, KeyHash: r.KeyHash, KeyPreview: r.KeyPreview,
		Status: r.Status, ModelAllowlist: r.ModelAllowlist, QuotaLimit: r.QuotaLimit, QuotaUsed: r.QuotaUsed, Reserved: r.Reserved,
		ExpiresAt: r.ExpiresAt, LastUsedAt: r.LastUsedAt, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		AccountName: r.AccountName, AccountTenant: r.AccountTenant, AccountGroup: r.AccountGroup, AccountStatus: r.AccountStatus,
		AccountQuotaLimit: r.AccountQuotaLimit, AccountQuotaUsed: r.AccountQuotaUsed, AccountReserved: r.AccountReserved}
}

func toKey(r sqlcgen.GetKeyByHashRow) store.Key {
	return store.Key{ID: r.ID, AccountID: r.AccountID, Name: r.Name, KeyHash: r.KeyHash, KeyPreview: r.KeyPreview,
		Status: r.Status, ModelAllowlist: parseAllowlist(r.ModelAllowlist), QuotaLimit: r.QuotaLimit, QuotaUsed: r.QuotaUsed,
		Reserved: r.Reserved, ExpiresAt: r.ExpiresAt, LastUsedAt: r.LastUsedAt, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Account: store.Account{ID: r.AccountID, Name: r.AccountName, Tenant: r.AccountTenant, Group: r.AccountGroup,
			Status: r.AccountStatus, QuotaLimit: r.AccountQuotaLimit, QuotaUsed: r.AccountQuotaUsed, Reserved: r.AccountReserved}}
}

func parseAllowlist(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	var out []string
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}
	return out
}

func encodeAllowlist(list []string) []byte {
	if len(list) == 0 {
		return nil
	}
	b, _ := json.Marshal(list)
	return b
}

func derefText(t pgtype.Text) string {
	if !t.Valid {
		return ""
	}
	return t.String
}

func (d *DB) GetKeyByHash(ctx context.Context, hash string) (store.Key, error) {
	r, err := d.q.GetKeyByHash(ctx, hash)
	if err != nil {
		return store.Key{}, d.fail("GetKeyByHash", err)
	}
	return toKey(r), nil
}

func (d *DB) GetKey(ctx context.Context, id uuid.UUID) (store.Key, error) {
	r, err := d.q.GetKey(ctx, id)
	if err != nil {
		return store.Key{}, d.fail("GetKey", err)
	}
	return toKey(rowToHashRow(r)), nil
}

func (d *DB) ListKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]store.Key, error) {
	rows, err := d.q.ListKeys(ctx, sqlcgen.ListKeysParams{AccountID: accountID, Lim: int32(limit)})
	if err != nil {
		return nil, d.fail("ListKeys", err)
	}
	out := make([]store.Key, 0, len(rows))
	for _, r := range rows {
		out = append(out, toKey(listRowToHashRow(r)))
	}
	return out, nil
}

func (d *DB) CreateKey(ctx context.Context, k store.Key, allowlist []string) (store.Key, error) {
	row, err := d.q.CreateKey(ctx, sqlcgen.CreateKeyParams{ID: k.ID, AccountID: k.AccountID, Name: k.Name, KeyHash: k.KeyHash,
		KeyPreview: k.KeyPreview, Status: k.Status, ModelAllowlist: encodeAllowlist(allowlist), QuotaLimit: k.QuotaLimit, ExpiresAt: k.ExpiresAt})
	if err != nil {
		return store.Key{}, d.fail("CreateKey", err)
	}
	full, err := d.GetKey(ctx, row.ID)
	return full, err
}

func (d *DB) UpdateKey(ctx context.Context, id uuid.UUID, status string, allowlist []string, quotaLimit *int64, expiresAt *time.Time, name string) (store.Key, error) {
	row, err := d.q.UpdateKey(ctx, sqlcgen.UpdateKeyParams{ID: id, Status: status, ModelAllowlist: encodeAllowlist(allowlist),
		QuotaLimit: quotaLimit, ExpiresAt: expiresAt, Name: name})
	if err != nil {
		return store.Key{}, d.fail("UpdateKey", err)
	}
	return d.GetKey(ctx, row.ID)
}

func (d *DB) ReserveKeyQuota(ctx context.Context, id uuid.UUID, nanos int64) (store.QuotaState, error) {
	if nanos <= 0 {
		k, err := d.GetKey(ctx, id)
		return store.QuotaState{Limit: k.QuotaLimit, Used: k.QuotaUsed, Reserved: k.Reserved}, err
	}
	q, err := d.q.ReserveKeyQuota(ctx, sqlcgen.ReserveKeyQuotaParams{ID: id, Reserved: nanos})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.QuotaState{}, loom.ErrInsufficientQuota
	}
	return toQuota(q.QuotaLimit, q.QuotaUsed, q.Reserved), d.fail("ReserveKeyQuota", err)
}

func (d *DB) ReleaseKeyReservation(ctx context.Context, id uuid.UUID, nanos int64) error {
	if nanos <= 0 {
		return nil
	}
	return d.fail("ReleaseKeyReservation", d.q.ReleaseKeyReservation(ctx, sqlcgen.ReleaseKeyReservationParams{ID: id, Reserved: nanos}))
}

// ---- reservations & settle ----

func toReservation(r sqlcgen.Reservation) store.Reservation {
	return store.Reservation{RequestID: r.RequestID, KeyID: r.KeyID, AccountID: r.AccountID, Model: r.Model,
		Nanos: r.Nanos, ExpiresAt: r.ExpiresAt, CreatedAt: r.CreatedAt}
}

func (d *DB) CreateReservation(ctx context.Context, r store.Reservation) error {
	return d.fail("CreateReservation", d.q.CreateReservation(ctx, sqlcgen.CreateReservationParams{RequestID: r.RequestID,
		KeyID: r.KeyID, AccountID: r.AccountID, Model: r.Model, Nanos: r.Nanos, ExpiresAt: r.ExpiresAt}))
}

func (d *DB) GetReservation(ctx context.Context, requestID string) (store.Reservation, error) {
	r, err := d.q.GetReservation(ctx, requestID)
	return toReservation(r), d.fail("GetReservation", err)
}

func (d *DB) ListReservations(ctx context.Context, limit int) ([]store.Reservation, error) {
	rows, err := d.q.ListReservations(ctx, int32(limit))
	if err != nil {
		return nil, d.fail("ListReservations", err)
	}
	out := make([]store.Reservation, 0, len(rows))
	for _, r := range rows {
		out = append(out, toReservation(r))
	}
	return out, nil
}

func (d *DB) CountReservations(ctx context.Context) (int64, error) {
	n, err := d.q.CountReservations(ctx)
	return n, d.fail("CountReservations", err)
}

func usageParams(ev store.UsageEvent) sqlcgen.SettleUsageParams {
	return sqlcgen.SettleUsageParams{Time: ev.Time, RequestID: pgtype.Text{String: ev.RequestID, Valid: ev.RequestID != ""},
		TraceID: ev.TraceID, SpanID: ev.SpanID, AccountID: ev.AccountID, KeyID: ev.KeyID, Model: ev.Model, Provider: ev.Provider,
		Route: ev.Route, Gateway: ev.Gateway, InputTokens: ev.InputTokens, OutputTokens: ev.OutputTokens, CachedTokens: ev.CachedTokens,
		CostNanos: ev.CostNanos, GatewayCostNanos: ev.GatewayCostNanos, PricingSource: ev.PricingSource}
}

// SettleUsage 见 store.Store。
func (d *DB) SettleUsage(ctx context.Context, ev store.UsageEvent) (bool, error) {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return false, d.fail("SettleUsage.Begin", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := d.q.WithTx(tx)
	_, err = q.SettleUsage(ctx, usageParams(ev))
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // 重复投递：request_id 已存在，不重复扣费
	}
	if err != nil {
		return false, d.fail("SettleUsage.Insert", err)
	}
	if ev.KeyID != nil {
		res, err := q.GetReservation(ctx, ev.RequestID)
		switch {
		case err == nil:
			if err := q.SettleKeyQuota(ctx, sqlcgen.SettleKeyQuotaParams{ID: res.KeyID, Reserved: res.Nanos, QuotaUsed: ev.CostNanos}); err != nil {
				return false, d.fail("SettleUsage.SettleKey", err)
			}
			if err := q.SettleAccountQuota(ctx, sqlcgen.SettleAccountQuotaParams{ID: res.AccountID, Reserved: res.Nanos, QuotaUsed: ev.CostNanos}); err != nil {
				return false, d.fail("SettleUsage.SettleAccount", err)
			}
			if err := q.DeleteReservation(ctx, ev.RequestID); err != nil {
				return false, d.fail("SettleUsage.DeleteReservation", err)
			}
		case errors.Is(err, pgx.ErrNoRows):
			// 没有预扣记录（预扣为 0、已过期释放、鉴权时未预扣）：直接累加
			if err := q.AddKeyUsed(ctx, sqlcgen.AddKeyUsedParams{ID: *ev.KeyID, QuotaUsed: ev.CostNanos}); err != nil {
				return false, d.fail("SettleUsage.AddKeyUsed", err)
			}
			if ev.AccountID != nil {
				if err := q.AddAccountUsed(ctx, sqlcgen.AddAccountUsedParams{ID: *ev.AccountID, QuotaUsed: ev.CostNanos}); err != nil {
					return false, d.fail("SettleUsage.AddAccountUsed", err)
				}
			}
		default:
			return false, d.fail("SettleUsage.GetReservation", err)
		}
	} else if ev.AccountID != nil {
		if err := q.AddAccountUsed(ctx, sqlcgen.AddAccountUsedParams{ID: *ev.AccountID, QuotaUsed: ev.CostNanos}); err != nil {
			return false, d.fail("SettleUsage.AddAccountUsed", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, d.fail("SettleUsage.Commit", err)
	}
	return true, nil
}

// ReleaseExpiredReservations 见 store.Store。
func (d *DB) ReleaseExpiredReservations(ctx context.Context, now time.Time, limit int) (int, error) {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return 0, d.fail("ReleaseExpired.Begin", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := d.q.WithTx(tx)
	rows, err := q.LockExpiredReservations(ctx, sqlcgen.LockExpiredReservationsParams{ExpiresAt: now, Limit: int32(limit)})
	if err != nil {
		return 0, d.fail("ReleaseExpired.Lock", err)
	}
	for _, r := range rows {
		if err := q.ReleaseKeyReservation(ctx, sqlcgen.ReleaseKeyReservationParams{ID: r.KeyID, Reserved: r.Nanos}); err != nil {
			return 0, d.fail("ReleaseExpired.ReleaseKey", err)
		}
		if err := q.ReleaseAccountReservation(ctx, sqlcgen.ReleaseAccountReservationParams{ID: r.AccountID, Reserved: r.Nanos}); err != nil {
			return 0, d.fail("ReleaseExpired.ReleaseAccount", err)
		}
		if err := q.DeleteReservation(ctx, r.RequestID); err != nil {
			return 0, d.fail("ReleaseExpired.Delete", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, d.fail("ReleaseExpired.Commit", err)
	}
	return len(rows), nil
}

// ---- usage ----

func toUsage(u sqlcgen.UsageEvent) store.UsageEvent {
	return store.UsageEvent{ID: u.ID, Time: u.Time, RequestID: derefText(u.RequestID), TraceID: u.TraceID, SpanID: u.SpanID,
		AccountID: u.AccountID, KeyID: u.KeyID, Model: u.Model, Provider: u.Provider, Route: u.Route, Gateway: u.Gateway,
		InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, CachedTokens: u.CachedTokens, CostNanos: u.CostNanos,
		GatewayCostNanos: u.GatewayCostNanos, PricingSource: u.PricingSource, Settled: u.Settled}
}

func (d *DB) ListUsage(ctx context.Context, keyID *uuid.UUID, since *time.Time, limit int) ([]store.UsageEvent, error) {
	rows, err := d.q.ListUsage(ctx, sqlcgen.ListUsageParams{KeyID: keyID, Since: since, Lim: int32(limit)})
	if err != nil {
		return nil, d.fail("ListUsage", err)
	}
	out := make([]store.UsageEvent, 0, len(rows))
	for _, r := range rows {
		out = append(out, toUsage(r))
	}
	return out, nil
}

func (d *DB) SummaryUsage(ctx context.Context, f store.UsageFilter) ([]store.UsageSummaryRow, error) {
	rows, err := d.q.SummaryUsage(ctx, sqlcgen.SummaryUsageParams{AccountID: f.AccountID, KeyID: f.KeyID, Since: f.Since})
	if err != nil {
		return nil, d.fail("SummaryUsage", err)
	}
	out := make([]store.UsageSummaryRow, 0, len(rows))
	for _, r := range rows {
		row := store.UsageSummaryRow{Model: r.Model, Requests: r.Requests, InputTokens: r.InputTokens, OutputTokens: r.OutputTokens,
			CachedTokens: r.CachedTokens, CostNanos: r.CostNanos, GatewayCostNanos: r.GatewayCostNanos}
		if r.AccountID != nil {
			row.AccountID = *r.AccountID
		}
		if r.KeyID != nil {
			row.KeyID = *r.KeyID
		}
		out = append(out, row)
	}
	return out, nil
}

// ---- audit ----

func (d *DB) InsertAudit(ctx context.Context, rows []store.Audit) error {
	if len(rows) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(`INSERT INTO auth_audit (time, request_id, client_request_id, key_id, account_id, source, model, allowed, status, reason)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, r.Time, r.RequestID, r.ClientRequestID, r.KeyID, r.AccountID, r.Source, r.Model, r.Allowed, r.Status, r.Reason)
	}
	res := d.pool.SendBatch(ctx, batch)
	defer func() { _ = res.Close() }()
	for range rows {
		if _, err := res.Exec(); err != nil {
			return d.fail("InsertAudit", err)
		}
	}
	return nil
}

func (d *DB) ListAudit(ctx context.Context, keyID *uuid.UUID, limit int) ([]store.Audit, error) {
	rows, err := d.q.ListAudit(ctx, sqlcgen.ListAuditParams{KeyID: keyID, Lim: int32(limit)})
	if err != nil {
		return nil, d.fail("ListAudit", err)
	}
	out := make([]store.Audit, 0, len(rows))
	for _, r := range rows {
		out = append(out, store.Audit{Time: r.Time, RequestID: r.RequestID, ClientRequestID: r.ClientRequestID, KeyID: r.KeyID,
			AccountID: r.AccountID, Source: r.Source, Model: r.Model, Allowed: r.Allowed, Status: int(r.Status), Reason: r.Reason})
	}
	return out, nil
}

// ---- pg fallback pricing ----

func toPrice(m sqlcgen.ModelPricing) store.ModelPrice {
	var ri, ro *int
	if m.ReserveInputTokens != nil {
		v := int(*m.ReserveInputTokens)
		ri = &v
	}
	if m.ReserveOutputTokens != nil {
		v := int(*m.ReserveOutputTokens)
		ro = &v
	}
	return store.ModelPrice{Model: m.Model, ModelRatio: m.ModelRatio, CompletionRatio: m.CompletionRatio, CacheRatio: m.CacheRatio,
		ModelPrice: m.ModelPrice, ReserveInputTokens: ri, ReserveOutputTokens: ro, Enabled: m.Enabled, UpdatedAt: m.UpdatedAt}
}

func (d *DB) ListModelPricing(ctx context.Context) ([]store.ModelPrice, error) {
	rows, err := d.q.ListModelPricing(ctx)
	if err != nil {
		return nil, d.fail("ListModelPricing", err)
	}
	out := make([]store.ModelPrice, 0, len(rows))
	for _, r := range rows {
		out = append(out, toPrice(r))
	}
	return out, nil
}

func (d *DB) GetModelPricing(ctx context.Context, model string) (store.ModelPrice, error) {
	m, err := d.q.GetModelPricing(ctx, model)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.ModelPrice{}, loom.ErrNotFound
	}
	return toPrice(m), d.fail("GetModelPricing", err)
}

func (d *DB) UpsertModelPricing(ctx context.Context, p store.ModelPrice) error {
	return d.fail("UpsertModelPricing", d.q.UpsertModelPricing(ctx, sqlcgen.UpsertModelPricingParams{Model: p.Model,
		ModelRatio: p.ModelRatio, CompletionRatio: p.CompletionRatio, CacheRatio: p.CacheRatio, ModelPrice: p.ModelPrice,
		ReserveInputTokens: p.ReserveInputTokens, ReserveOutputTokens: p.ReserveOutputTokens}))
}

func (d *DB) DeleteModelPricing(ctx context.Context, model string) error {
	return d.fail("DeleteModelPricing", d.q.DeleteModelPricing(ctx, model))
}

// IsUniqueViolation 判断是否唯一键冲突。
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
