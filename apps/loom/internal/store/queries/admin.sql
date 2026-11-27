-- name: LockAccountQuota :one
SELECT quota_limit, quota_used FROM accounts WHERE id = $1 FOR UPDATE;

-- name: LockKeyQuota :one
SELECT account_id, quota_limit, quota_used FROM api_keys WHERE id = $1 FOR UPDATE;

-- name: InsertQuotaAdjustment :exec
INSERT INTO quota_adjustments (account_id, key_id, kind, limit_before, limit_after, used_before, used_after, actor)
VALUES ($1, sqlc.narg(key_id), $2, sqlc.narg(limit_before), sqlc.narg(limit_after), $3, $4, $5);

-- name: ListQuotaAdjustments :many
SELECT * FROM quota_adjustments
WHERE (sqlc.narg(account_id)::uuid IS NULL OR account_id = sqlc.narg(account_id))
  AND (sqlc.narg(key_id)::uuid IS NULL OR key_id = sqlc.narg(key_id))
ORDER BY id DESC
LIMIT sqlc.arg(lim);

-- name: CreateAdminToken :one
INSERT INTO admin_tokens (id, name, token_hash, token_preview, role)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetAdminTokenByHash :one
SELECT * FROM admin_tokens WHERE token_hash = $1 AND revoked_at IS NULL;

-- name: ListAdminTokens :many
SELECT * FROM admin_tokens ORDER BY created_at;

-- name: RevokeAdminToken :execrows
UPDATE admin_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL;

-- name: InsertAdminAudit :exec
INSERT INTO admin_audit (actor, method, route, target, request, status)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: ListAdminAudit :many
SELECT * FROM admin_audit ORDER BY id DESC LIMIT $1;
