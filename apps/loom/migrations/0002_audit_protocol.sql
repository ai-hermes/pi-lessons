-- +goose Up
-- 准入审计只记录准入结论；HTTP 状态码由 reason 决定（见 config extauth.deny_status），不再冗余存储。
ALTER TABLE auth_audit DROP COLUMN status;
ALTER TABLE auth_audit RENAME COLUMN source TO protocol;

-- +goose Down
ALTER TABLE auth_audit RENAME COLUMN protocol TO source;
ALTER TABLE auth_audit ADD COLUMN status int NOT NULL DEFAULT 0;
