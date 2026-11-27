-- name: GetAccount :one
SELECT * FROM accounts WHERE id = $1;

-- name: GetAccountByName :one
SELECT * FROM accounts WHERE name = $1;

-- name: ListAccounts :many
SELECT * FROM accounts ORDER BY created_at DESC LIMIT sqlc.arg(lim);

-- name: CreateAccount :one
INSERT INTO accounts (id, name, tenant, "group", status, quota_limit, rpm, tpm, max_concurrency)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: UpdateAccount :one
UPDATE accounts
SET status          = $2,
    quota_limit     = $3,
    "group"         = $4,
    rpm             = $5,
    tpm             = $6,
    max_concurrency = $7,
    updated_at      = now()
WHERE id = $1
RETURNING *;

-- name: AddAccountQuotaLimit :one
UPDATE accounts
SET quota_limit = COALESCE(quota_limit, 0) + $2, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: ReleaseAccountReservation :exec
UPDATE accounts
SET reserved = reserved - $2, in_flight = in_flight - 1, updated_at = now()
WHERE id = $1;

-- name: SettleAccountQuota :exec
UPDATE accounts
SET quota_used = quota_used + $3,
    reserved   = reserved - $2,
    in_flight  = in_flight - 1,
    updated_at = now()
WHERE id = $1;

-- name: AddAccountUsed :exec
UPDATE accounts
SET quota_used = quota_used + $2, updated_at = now()
WHERE id = $1;

-- name: SetAccountQuota :exec
UPDATE accounts
SET quota_limit = $2, quota_used = $3, reserved = 0, in_flight = 0, updated_at = now()
WHERE id = $1;

-- name: DeleteAccountReservations :exec
-- 删除一个账户的全部预扣，并从各 Key 扣回对应的 reserved 与 in_flight（账户自身由 SetAccountQuota 清零）。
WITH gone AS (
    DELETE FROM reservations WHERE reservations.account_id = $1 RETURNING reservations.key_id, reservations.nanos
), totals AS (
    SELECT key_id, sum(nanos)::bigint AS nanos, count(*) AS n FROM gone GROUP BY key_id
)
UPDATE api_keys k
SET reserved = k.reserved - totals.nanos, in_flight = k.in_flight - totals.n, updated_at = now()
FROM totals
WHERE k.id = totals.key_id;
