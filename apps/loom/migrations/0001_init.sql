-- +goose Up
-- +goose StatementBegin

-- 账户：额度的第一级，按分组享受不同倍率
CREATE TABLE accounts (
    id           uuid PRIMARY KEY,
    name         text NOT NULL UNIQUE,
    tenant       text NOT NULL DEFAULT '',
    "group"      text NOT NULL DEFAULT 'default',
    status       text NOT NULL DEFAULT 'active',  -- active | disabled
    quota_limit  bigint,                           -- NULL = 不限
    quota_used   bigint NOT NULL DEFAULT 0,
    reserved     bigint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- API Key：额度的第二级，只存 sha256 摘要
CREATE TABLE api_keys (
    id              uuid PRIMARY KEY,
    account_id      uuid NOT NULL REFERENCES accounts(id),
    name            text NOT NULL,
    key_hash        text NOT NULL UNIQUE,
    key_preview     text NOT NULL,
    status          text NOT NULL DEFAULT 'active',  -- active | disabled
    model_allowlist jsonb,                           -- NULL = 全部模型
    quota_limit     bigint,                          -- NULL = 跟随账户
    quota_used      bigint NOT NULL DEFAULT 0,
    reserved        bigint NOT NULL DEFAULT 0,
    expires_at      timestamptz,
    last_used_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_account_idx ON api_keys(account_id, created_at);

-- 鉴权阶段的预扣记录，结算后删除
CREATE TABLE reservations (
    request_id  text PRIMARY KEY,
    key_id      uuid NOT NULL,
    account_id  uuid NOT NULL,
    model       text NOT NULL,
    nanos       bigint NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservations_expires_idx ON reservations(expires_at);

-- 计费明细：request_id 幂等
CREATE TABLE usage_events (
    id                  bigserial PRIMARY KEY,
    time                timestamptz NOT NULL DEFAULT now(),
    request_id          text UNIQUE,
    trace_id            text NOT NULL DEFAULT '',
    span_id             text NOT NULL DEFAULT '',
    account_id          uuid,
    key_id              uuid,
    model               text NOT NULL,
    provider            text NOT NULL DEFAULT '',
    route               text NOT NULL DEFAULT '',
    gateway             text NOT NULL DEFAULT '',
    input_tokens        bigint NOT NULL DEFAULT 0,
    output_tokens       bigint NOT NULL DEFAULT 0,
    cached_tokens       bigint NOT NULL DEFAULT 0,
    cost_nanos          bigint NOT NULL DEFAULT 0,
    gateway_cost_nanos  bigint,
    pricing_source      text NOT NULL DEFAULT '',
    settled             boolean NOT NULL DEFAULT false
);
CREATE INDEX usage_events_time_idx ON usage_events(time);
CREATE INDEX usage_events_agg_idx ON usage_events(account_id, key_id, model, time);

CREATE TABLE auth_audit (
    id            bigserial PRIMARY KEY,
    time          timestamptz NOT NULL DEFAULT now(),
    request_id    text NOT NULL DEFAULT '',
    client_request_id text NOT NULL DEFAULT '',
    key_id        uuid,
    account_id    uuid,
    source        text NOT NULL DEFAULT '',
    model         text NOT NULL DEFAULT '',
    allowed       boolean NOT NULL,
    status        int NOT NULL,
    reason        text NOT NULL
);
CREATE INDEX auth_audit_time_idx ON auth_audit(time);

-- PG 兜底定价：ConfigMap 没有的模型从这里查
CREATE TABLE model_pricing (
    model                 text PRIMARY KEY,
    model_ratio           double precision NOT NULL DEFAULT 1,
    completion_ratio      double precision NOT NULL DEFAULT 1,
    cache_ratio           double precision NOT NULL DEFAULT 1,
    model_price           double precision,
    reserve_input_tokens  integer,
    reserve_output_tokens integer,
    enabled               boolean NOT NULL DEFAULT true,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE model_pricing;
DROP TABLE auth_audit;
DROP TABLE usage_events;
DROP TABLE reservations;
DROP TABLE api_keys;
DROP TABLE accounts;
-- +goose StatementEnd
