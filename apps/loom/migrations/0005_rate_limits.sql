-- +goose Up
-- 客户级限流：API Key 与账户两级的 RPM / TPM / 最大并发；NULL 表示不限（账户未配置时取分组默认值）。
-- in_flight 是未结算的预扣记录数，与 reserved 在同一条 UPDATE 中条件递增，并发上限因此是精确的。
ALTER TABLE accounts
    ADD COLUMN rpm             bigint CHECK (rpm > 0),
    ADD COLUMN tpm             bigint CHECK (tpm > 0),
    ADD COLUMN max_concurrency bigint CHECK (max_concurrency > 0),
    ADD COLUMN in_flight       bigint NOT NULL DEFAULT 0;
ALTER TABLE api_keys
    ADD COLUMN rpm             bigint CHECK (rpm > 0),
    ADD COLUMN tpm             bigint CHECK (tpm > 0),
    ADD COLUMN max_concurrency bigint CHECK (max_concurrency > 0),
    ADD COLUMN in_flight       bigint NOT NULL DEFAULT 0;

-- 已有的预扣记录计入 in_flight，保证升级后结算递减不会变成负数。
UPDATE api_keys k SET in_flight = (SELECT count(*) FROM reservations r WHERE r.key_id = k.id);
UPDATE accounts a SET in_flight = (SELECT count(*) FROM reservations r WHERE r.account_id = a.id);

-- RPM / TPM 的分钟固定窗口计数；subject 是 API Key 或账户的 id（uuid 不会重复，scope 只为可读）。
CREATE TABLE rate_counters (
    subject      uuid        NOT NULL,
    window_start timestamptz NOT NULL,
    scope        text        NOT NULL CHECK (scope IN ('api_key', 'account')),
    requests     bigint      NOT NULL DEFAULT 0,
    tokens       bigint      NOT NULL DEFAULT 0,
    PRIMARY KEY (subject, window_start)
);
CREATE INDEX rate_counters_window_idx ON rate_counters (window_start);

-- +goose Down
DROP TABLE rate_counters;
ALTER TABLE api_keys DROP COLUMN rpm, DROP COLUMN tpm, DROP COLUMN max_concurrency, DROP COLUMN in_flight;
ALTER TABLE accounts DROP COLUMN rpm, DROP COLUMN tpm, DROP COLUMN max_concurrency, DROP COLUMN in_flight;
