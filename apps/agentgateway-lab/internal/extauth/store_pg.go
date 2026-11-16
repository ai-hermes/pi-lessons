package extauth

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PGStore is the production store. Queries are intentionally simple selects:
// the authorization hot path must stay O(1) and never block on a write.
type PGStore struct {
	pool *pgxpool.Pool
	// audit is buffered so a slow PostgreSQL never adds latency to a request.
	audit chan AuditEvent
}

const clientCols = `client_id, tenant, plan, status, budget_cents, spent_micros`

func NewPGStore(ctx context.Context, dsn string) (*PGStore, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	s := &PGStore{pool: pool, audit: make(chan AuditEvent, 1024)}
	go s.flushAudits()
	return s, nil
}

func (s *PGStore) scan(row interface{ Scan(...any) error }) (*Client, bool) {
	var c Client
	if err := row.Scan(&c.ClientID, &c.Tenant, &c.Plan, &c.Status, &c.BudgetCents, &c.SpentMicros); err != nil {
		return nil, false
	}
	return &c, true
}

func (s *PGStore) LookupKey(hash string) (*Client, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	row := s.pool.QueryRow(ctx, `SELECT `+clientCols+` FROM clients WHERE api_key_hash = $1`, hash)
	return s.scan(row)
}

func (s *PGStore) LookupSession(hash string, now time.Time) (*Client, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	row := s.pool.QueryRow(ctx, `SELECT c.client_id, c.tenant, c.plan, c.status, c.budget_cents, c.spent_micros
FROM sessions s JOIN clients c ON c.client_id = s.client_id
WHERE s.token_hash = $1 AND s.expires_at > $2`, hash, now)
	return s.scan(row)
}

func (s *PGStore) LookupClient(id string) (*Client, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	row := s.pool.QueryRow(ctx, `SELECT `+clientCols+` FROM clients WHERE client_id = $1`, id)
	return s.scan(row)
}

func (s *PGStore) Audit(e AuditEvent) {
	select {
	case s.audit <- e:
	default: // audit is best-effort: never block the request path
	}
}

func (s *PGStore) flushAudits() {
	for e := range s.audit {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, err := s.pool.Exec(ctx, `INSERT INTO auth_audit
(time, client_id, source, allowed, status, reason, method, path, remote_addr)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			e.Time, e.ClientID, e.Source, e.Allow, e.Status, e.Reason, e.Method, e.Path, e.RemoteAddr)
		cancel()
		if err != nil {
			// Swallowed on purpose; consult PostgreSQL logs when auditing matters.
			_ = err
		}
	}
}

func (s *PGStore) Close() {
	close(s.audit)
	s.pool.Close()
}

// UpsertClient is used by /admin/clients so dump-and-restore and CI seeding
// never need to hand-edit PostgreSQL.
func (s *PGStore) UpsertClient(ctx context.Context, clientID, tenant, plan, status string, budgetCents int64, keyHash string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO clients (client_id, tenant, plan, status, budget_cents, api_key_hash)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (client_id) DO UPDATE SET tenant=EXCLUDED.tenant, plan=EXCLUDED.plan,
status=EXCLUDED.status, budget_cents=EXCLUDED.budget_cents, api_key_hash=EXCLUDED.api_key_hash`,
		clientID, tenant, plan, status, budgetCents, keyHash)
	return err
}

// InsertSession registers a short-lived session token (standalone-auth mode).
func (s *PGStore) InsertSession(ctx context.Context, tokenHash, clientID string, expires time.Time) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO sessions (token_hash, client_id, expires_at)
VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
		tokenHash, clientID, expires)
	return err
}

// Exec exposes the pool for the finops service (single pool, single DSN).
func (s *PGStore) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := s.pool.Exec(ctx, sql, args...)
	return err
}
