-- name: GetKeyByHash :one
SELECT k.*, a.name AS account_name, a.tenant AS account_tenant, a."group" AS account_group,
       a.status AS account_status, a.quota_limit AS account_quota_limit,
       a.quota_used AS account_quota_used, a.reserved AS account_reserved
FROM api_keys k
JOIN accounts a ON a.id = k.account_id
WHERE k.key_hash = $1;

-- name: GetKey :one
SELECT k.*, a.name AS account_name, a.tenant AS account_tenant, a."group" AS account_group,
       a.status AS account_status, a.quota_limit AS account_quota_limit,
       a.quota_used AS account_quota_used, a.reserved AS account_reserved
FROM api_keys k
JOIN accounts a ON a.id = k.account_id
WHERE k.id = $1;

-- name: ListKeys :many
SELECT k.*, a.name AS account_name, a.tenant AS account_tenant, a."group" AS account_group,
       a.status AS account_status, a.quota_limit AS account_quota_limit,
       a.quota_used AS account_quota_used, a.reserved AS account_reserved
FROM api_keys k
JOIN accounts a ON a.id = k.account_id
WHERE sqlc.narg(account_id)::uuid IS NULL OR k.account_id = sqlc.narg(account_id)
ORDER BY k.created_at DESC
LIMIT sqlc.arg(lim);

-- name: CreateKey :one
INSERT INTO api_keys (id, account_id, name, key_hash, key_preview, status, model_allowlist, quota_limit, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: UpdateKey :one
UPDATE api_keys
SET status          = $2,
    model_allowlist = $3,
    quota_limit     = $4,
    expires_at      = $5,
    name            = $6,
    updated_at      = now()
WHERE id = $1
RETURNING *;

-- name: ReserveKeyQuota :one
UPDATE api_keys
SET reserved = reserved + $2, last_used_at = now(), updated_at = now()
WHERE id = $1
  AND status = 'active'
  AND (expires_at IS NULL OR expires_at > now())
  AND (quota_limit IS NULL OR quota_limit - quota_used - reserved >= $2)
RETURNING id, quota_limit, quota_used, reserved;

-- name: ReleaseKeyReservation :exec
UPDATE api_keys
SET reserved = reserved - $2, updated_at = now()
WHERE id = $1;

-- name: SettleKeyQuota :exec
UPDATE api_keys
SET quota_used = quota_used + $3,
    reserved   = reserved - $2,
    updated_at  = now()
WHERE id = $1;

-- name: AddKeyUsed :exec
UPDATE api_keys
SET quota_used = quota_used + $2, updated_at = now()
WHERE id = $1;

-- name: SetKeyQuota :exec
UPDATE api_keys
SET quota_limit = $2, quota_used = $3, reserved = 0, updated_at = now()
WHERE id = $1;

-- name: DeleteKeyReservations :execrows
DELETE FROM reservations WHERE key_id = $1;
