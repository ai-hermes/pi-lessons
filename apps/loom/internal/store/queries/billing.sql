-- name: CreateReservation :exec
INSERT INTO reservations (request_id, key_id, account_id, model, nanos, expires_at)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: GetReservation :one
SELECT * FROM reservations WHERE request_id = $1;

-- name: ListReservations :many
SELECT * FROM reservations ORDER BY created_at DESC LIMIT sqlc.arg(lim);

-- name: CountReservations :one
SELECT count(*) FROM reservations;

-- name: DeleteReservation :exec
DELETE FROM reservations WHERE request_id = $1;

-- name: LockExpiredReservations :many
SELECT * FROM reservations
WHERE expires_at < $1
ORDER BY expires_at
LIMIT $2
FOR UPDATE SKIP LOCKED;

-- name: SettleUsage :one
WITH ins AS (
    INSERT INTO usage_events (time, request_id, trace_id, span_id, account_id, key_id, model, provider,
                               route, gateway, input_tokens, output_tokens, cached_tokens,
                               cost_nanos, gateway_cost_nanos, pricing_source, settled)
    VALUES ($1, sqlc.narg(request_id), $2, $3, sqlc.narg(account_id), sqlc.narg(key_id), $4, $5,
            $6, $7, $8, $9, $10, $11, sqlc.narg(gateway_cost_nanos), $12, true)
    ON CONFLICT (request_id) DO NOTHING
    RETURNING id
)
SELECT id FROM ins;

-- name: ListUsage :many
SELECT * FROM usage_events
WHERE (sqlc.narg(key_id)::uuid IS NULL OR key_id = sqlc.narg(key_id))
  AND (sqlc.narg(since)::timestamptz IS NULL OR time >= sqlc.narg(since))
ORDER BY time DESC
LIMIT sqlc.arg(lim);

-- name: SummaryUsage :many
SELECT
    COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid) AS account_id,
    COALESCE(key_id, '00000000-0000-0000-0000-000000000000'::uuid)     AS key_id,
    model,
    count(*)                              AS requests,
    sum(input_tokens)                      AS input_tokens,
    sum(output_tokens)                     AS output_tokens,
    sum(cached_tokens)                     AS cached_tokens,
    sum(cost_nanos)                        AS cost_nanos,
    COALESCE(sum(gateway_cost_nanos), 0)::bigint AS gateway_cost_nanos
FROM usage_events
WHERE (sqlc.narg(account_id)::uuid IS NULL OR account_id = sqlc.narg(account_id))
  AND (sqlc.narg(key_id)::uuid IS NULL OR key_id = sqlc.narg(key_id))
  AND (sqlc.narg(since)::timestamptz IS NULL OR time >= sqlc.narg(since))
GROUP BY 1, 2, 3
ORDER BY cost_nanos DESC;

-- name: ListAudit :many
SELECT * FROM auth_audit
WHERE (sqlc.narg(key_id)::uuid IS NULL OR key_id = sqlc.narg(key_id))
ORDER BY time DESC
LIMIT sqlc.arg(lim);

-- name: ListModelPricing :many
SELECT * FROM model_pricing WHERE enabled ORDER BY model;

-- name: GetModelPricing :one
SELECT * FROM model_pricing WHERE model = $1 AND enabled;

-- name: UpsertModelPricing :exec
INSERT INTO model_pricing (model, model_ratio, completion_ratio, cache_ratio, model_price,
                           reserve_input_tokens, reserve_output_tokens, enabled)
VALUES ($1, $2, $3, $4, $5, $6, $7, true)
ON CONFLICT (model) DO UPDATE
SET model_ratio = EXCLUDED.model_ratio,
    completion_ratio = EXCLUDED.completion_ratio,
    cache_ratio = EXCLUDED.cache_ratio,
    model_price = EXCLUDED.model_price,
    reserve_input_tokens = EXCLUDED.reserve_input_tokens,
    reserve_output_tokens = EXCLUDED.reserve_output_tokens,
    enabled = true,
    updated_at = now();

-- name: DeleteModelPricing :exec
DELETE FROM model_pricing WHERE model = $1;

-- name: BackfillGatewayCost :execrows
UPDATE usage_events
SET gateway_cost_nanos = $2
WHERE request_id = $1 AND gateway_cost_nanos IS NULL;
