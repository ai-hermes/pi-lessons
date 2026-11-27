-- +goose Up
-- 管理 token：库中只存哈希，按角色授权；配置文件里的 admin.token 作为引导 token，不在此表。
CREATE TABLE admin_tokens (
    id            uuid PRIMARY KEY,
    name          text NOT NULL UNIQUE,
    token_hash    text NOT NULL UNIQUE,
    token_preview text NOT NULL,
    role          text NOT NULL CHECK (role IN ('read', 'write')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
);

-- 管理操作审计：每个写操作一行，请求体已脱敏。
CREATE TABLE admin_audit (
    id      bigserial PRIMARY KEY,
    time    timestamptz NOT NULL DEFAULT now(),
    actor   text NOT NULL,
    method  text NOT NULL,
    route   text NOT NULL,
    target  text NOT NULL DEFAULT '',
    request text NOT NULL DEFAULT '',
    status  int NOT NULL
);
CREATE INDEX admin_audit_time_idx ON admin_audit(time);

-- 额度变更流水：只追加，与额度修改在同一事务内写入。Key 的变更同时记录所属账户。
CREATE TABLE quota_adjustments (
    id           bigserial PRIMARY KEY,
    time         timestamptz NOT NULL DEFAULT now(),
    account_id   uuid NOT NULL,
    key_id       uuid,
    kind         text NOT NULL CHECK (kind IN ('top_up', 'reset')),
    limit_before bigint,
    limit_after  bigint,
    used_before  bigint NOT NULL,
    used_after   bigint NOT NULL,
    actor        text NOT NULL
);
CREATE INDEX quota_adjustments_account_idx ON quota_adjustments(account_id, id);
CREATE INDEX quota_adjustments_key_idx ON quota_adjustments(key_id, id);

-- +goose Down
DROP TABLE quota_adjustments;
DROP TABLE admin_audit;
DROP TABLE admin_tokens;
