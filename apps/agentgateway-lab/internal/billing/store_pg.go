package billing

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Store persists normalized usage events and answers chargeback queries.
type Store struct {
	pool *pgxpool.Pool
}

func NewStore(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Price returns the catalog entry for a model, or nil when the model is
// unknown (unknown models are still logged, with cost 0, so gaps are visible).
func (s *Store) Price(ctx context.Context, model string) (*Price, error) {
	row := s.pool.QueryRow(ctx, `SELECT model, input_micros_per_token, output_micros_per_token, cache_read_micros_per_token
FROM price_catalog WHERE model = $1`, model)
	var p Price
	if err := row.Scan(&p.Model, &p.InputMicrosPerTok, &p.OutputMicrosPerTok, &p.CacheReadMicrosPerTok); err != nil {
		return nil, err
	}
	return &p, nil
}

// InsertUsage writes one usage event and, when it belongs to a known client,
// increments the client's realized spend atomically so the authorizer's
// pre-check sees fresh budget numbers.
func (s *Store) InsertUsage(ctx context.Context, u Usage, costMicros int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `INSERT INTO usage_events
(time, request_id, client_id, tenant, model, provider, input_tokens, output_tokens, cached_tokens, realized_cost_micros, source)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		time.Now(), u.RequestID, u.ClientID, u.Tenant, u.Model, u.Provider,
		u.InputTokens, u.OutputTokens, u.CachedTokens, costMicros, "otlp")
	if err != nil {
		return err
	}
	if u.ClientID != "" {
		_, err = tx.Exec(ctx, `UPDATE clients SET spent_micros = spent_micros + $2 WHERE client_id = $1`, u.ClientID, costMicros)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Summary is one chargeback row: aggregated spend per tenant + client + model.
type Summary struct {
	Tenant             string    `json:"tenant"`
	ClientID           string    `json:"client_id"`
	Model              string    `json:"model"`
	Requests           int64     `json:"requests"`
	InputTokens        int64     `json:"input_tokens"`
	OutputTokens       int64     `json:"output_tokens"`
	CachedTokens       int64     `json:"cached_tokens"`
	RealizedCostMicros int64     `json:"realized_cost_micros"`
	RealizedCostUSD    float64   `json:"realized_cost_usd"`
	LastSeen           time.Time `json:"last_seen"`
}

// Summarize aggregates usage_events since a time, optionally filtered by tenant
// and client. This is the query a FinOps chargeback job would schedule.
func (s *Store) Summarize(ctx context.Context, since time.Time, tenant, client string) ([]Summary, error) {
	q := `SELECT COALESCE(tenant,''), COALESCE(client_id,''), COALESCE(model,''),
COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cached_tokens),0),
COALESCE(SUM(realized_cost_micros),0), MAX(time)
FROM usage_events WHERE time >= $1`
	args := []any{since}
	if tenant != "" {
		q += fmt.Sprintf(" AND tenant = $%d", len(args)+1)
		args = append(args, tenant)
	}
	if client != "" {
		q += fmt.Sprintf(" AND client_id = $%d", len(args)+1)
		args = append(args, client)
	}
	q += ` GROUP BY 1,2,3 ORDER BY 8 DESC`

	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Summary{}
	for rows.Next() {
		var s Summary
		if err := rows.Scan(&s.Tenant, &s.ClientID, &s.Model, &s.Requests, &s.InputTokens,
			&s.OutputTokens, &s.CachedTokens, &s.RealizedCostMicros, &s.LastSeen); err != nil {
			return nil, err
		}
		s.RealizedCostUSD = float64(s.RealizedCostMicros) / 1_000_000
		out = append(out, s)
	}
	return out, rows.Err()
}
