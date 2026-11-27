-- name: GetKeyByHash :one
SELECT k.*, a.name AS account_name, a.tenant AS account_tenant, a."group" AS account_group,
       a.status AS account_status, a.quota_limit AS account_quota_limit,
       a.quota_used AS account_quota_used, a.reserved AS account_reserved,
       a.rpm AS account_rpm, a.tpm AS account_tpm, a.max_concurrency AS account_max_concurrency,
       a.in_flight AS account_in_flight
FROM api_keys k
JOIN accounts a ON a.id = k.account_id
WHERE k.key_hash = $1;

-- name: GetKey :one
SELECT k.*, a.name AS account_name, a.tenant AS account_tenant, a."group" AS account_group,
       a.status AS account_status, a.quota_limit AS account_quota_limit,
       a.quota_used AS account_quota_used, a.reserved AS account_reserved,
       a.rpm AS account_rpm, a.tpm AS account_tpm, a.max_concurrency AS account_max_concurrency,
       a.in_flight AS account_in_flight
FROM api_keys k
JOIN accounts a ON a.id = k.account_id
WHERE k.id = $1;

-- name: ListKeys :many
SELECT k.*, a.name AS account_name, a.tenant AS account_tenant, a."group" AS account_group,
       a.status AS account_status, a.quota_limit AS account_quota_limit,
       a.quota_used AS account_quota_used, a.reserved AS account_reserved,
       a.rpm AS account_rpm, a.tpm AS account_tpm, a.max_concurrency AS account_max_concurrency,
       a.in_flight AS account_in_flight
FROM api_keys k
JOIN accounts a ON a.id = k.account_id
WHERE sqlc.narg(account_id)::uuid IS NULL OR k.account_id = sqlc.narg(account_id)
ORDER BY k.created_at DESC
LIMIT sqlc.arg(lim);

-- name: CreateKey :one
INSERT INTO api_keys (id, account_id, name, key_hash, key_preview, status, model_allowlist, quota_limit, expires_at,
                      rpm, tpm, max_concurrency)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: UpdateKey :one
UPDATE api_keys
SET status          = $2,
    model_allowlist = $3,
    quota_limit     = $4,
    expires_at      = $5,
    name            = $6,
    rpm             = $7,
    tpm             = $8,
    max_concurrency = $9,
    updated_at      = now()
WHERE id = $1
RETURNING *;

-- name: ReleaseKeyReservation :exec
UPDATE api_keys
SET reserved = reserved - $2, in_flight = in_flight - 1, updated_at = now()
WHERE id = $1;

-- name: SettleKeyQuota :exec
UPDATE api_keys
SET quota_used = quota_used + $3,
    reserved   = reserved - $2,
    in_flight  = in_flight - 1,
    updated_at = now()
WHERE id = $1;

-- name: AddKeyUsed :exec
UPDATE api_keys
SET quota_used = quota_used + $2, updated_at = now()
WHERE id = $1;

-- name: SetKeyQuota :exec
UPDATE api_keys
SET quota_limit = $2, quota_used = $3, reserved = 0, in_flight = 0, updated_at = now()
WHERE id = $1;

-- name: DeleteKeyReservations :exec
-- 删除一把 Key 的全部预扣，并从所属账户扣回对应的 reserved 与 in_flight（Key 自身由 SetKeyQuota 清零）。
WITH gone AS (
    DELETE FROM reservations WHERE reservations.key_id = $1 RETURNING reservations.account_id, reservations.nanos
), totals AS (
    SELECT account_id, sum(nanos)::bigint AS nanos, count(*) AS n FROM gone GROUP BY account_id
)
UPDATE accounts a
SET reserved = a.reserved - totals.nanos, in_flight = a.in_flight - totals.n, updated_at = now()
FROM totals
WHERE a.id = totals.account_id;
