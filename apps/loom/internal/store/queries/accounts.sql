-- name: GetAccount :one
SELECT * FROM accounts WHERE id = $1;

-- name: GetAccountByName :one
SELECT * FROM accounts WHERE name = $1;

-- name: ListAccounts :many
SELECT * FROM accounts ORDER BY created_at DESC LIMIT sqlc.arg(lim);

-- name: CreateAccount :one
INSERT INTO accounts (id, name, tenant, "group", status, quota_limit)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: UpdateAccount :one
UPDATE accounts
SET status      = $2,
    quota_limit = $3,
    "group"     = $4,
    updated_at  = now()
WHERE id = $1
RETURNING *;

-- name: AddAccountQuotaLimit :one
UPDATE accounts
SET quota_limit = COALESCE(quota_limit, 0) + $2, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: ReserveAccountQuota :one
UPDATE accounts
SET reserved = reserved + $2, updated_at = now()
WHERE id = $1
  AND status = 'active'
  AND (quota_limit IS NULL OR quota_limit - quota_used - reserved >= $2)
RETURNING id, quota_limit, quota_used, reserved;

-- name: ReleaseAccountReservation :exec
UPDATE accounts
SET reserved = reserved - $2, updated_at = now()
WHERE id = $1;

-- name: SettleAccountQuota :exec
UPDATE accounts
SET quota_used = quota_used + $3,
    reserved   = reserved - $2,
    updated_at  = now()
WHERE id = $1;

-- name: AddAccountUsed :exec
UPDATE accounts
SET quota_used = quota_used + $2, updated_at = now()
WHERE id = $1;

-- name: SetAccountQuota :exec
UPDATE accounts
SET quota_limit = $2, quota_used = $3, reserved = 0, updated_at = now()
WHERE id = $1;

-- name: DeleteAccountReservations :execrows
DELETE FROM reservations WHERE account_id = $1;
