-- +goose Up
-- 数据增长：幂等改由已结算请求表承担，usage_events / auth_audit 按月分区，新增日汇总表，准入审计支持聚合行。
-- 迁移会把两张大表的现有数据复制进新的分区表；生产库数据量大时请在维护窗口执行。

-- 1. 已结算请求表：request_id 为主键，承担结算幂等（分区表上的唯一约束必须包含分区键，无法再按 request_id 去重）。
--    usage_time 是该请求在 usage_events 中的 time，补写网关金额时用它定位分区。保留期默认 7 天。
CREATE TABLE settled_requests (
    request_id text PRIMARY KEY,
    usage_time timestamptz NOT NULL,
    settled_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settled_requests_settled_at_idx ON settled_requests (settled_at);
INSERT INTO settled_requests (request_id, usage_time, settled_at)
SELECT request_id, time, time FROM usage_events
WHERE request_id IS NOT NULL AND time > now() - interval '7 days';

-- 2. 按月分区的维护函数。分区名形如 usage_events_y2026m11，边界按 UTC 月初。
-- +goose StatementBegin
CREATE FUNCTION loom_ensure_month_partitions(parent text, first_month timestamptz, last_month timestamptz)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    m       timestamp := date_trunc('month', first_month AT TIME ZONE 'UTC');
    last    timestamp := date_trunc('month', last_month AT TIME ZONE 'UTC');
    name    text;
    created int := 0;
BEGIN
    WHILE m <= last LOOP
        name := format('%s_y%sm%s', parent, to_char(m, 'YYYY'), to_char(m, 'MM'));
        IF to_regclass(name) IS NULL THEN
            EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                           name, parent, m AT TIME ZONE 'UTC', (m + interval '1 month') AT TIME ZONE 'UTC');
            created := created + 1;
        END IF;
        m := m + interval '1 month';
    END LOOP;
    RETURN created;
END
$$;
-- +goose StatementEnd

-- 删除整月都早于 before 的分区（按分区名解析月份；当月及以后的分区永不删除），返回删除的分区数。
-- +goose StatementBegin
CREATE FUNCTION loom_drop_month_partitions(parent text, before timestamptz)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    part    record;
    month   timestamp;
    dropped int := 0;
BEGIN
    FOR part IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = parent AND c.relname ~ ('^' || parent || '_y[0-9]{4}m[0-9]{2}$')
        ORDER BY c.relname
    LOOP
        month := to_timestamp(right(part.relname, 8), '"y"YYYY"m"MM')::timestamp; -- 后缀形如 y2026m11
        -- 保险：当月及以后的分区无论 before 取何值都不删除
        IF (month + interval '1 month') AT TIME ZONE 'UTC' <= before
           AND month < date_trunc('month', now() AT TIME ZONE 'UTC') THEN
            EXECUTE format('DROP TABLE %I', part.relname);
            dropped := dropped + 1;
        END IF;
    END LOOP;
    RETURN dropped;
END
$$;
-- +goose StatementEnd

-- 3. usage_events 改为分区表：主键带上分区键，request_id 只建普通索引。
ALTER TABLE usage_events RENAME TO usage_events_legacy;
ALTER INDEX usage_events_time_idx RENAME TO usage_events_legacy_time_idx;
ALTER INDEX usage_events_agg_idx RENAME TO usage_events_legacy_agg_idx;
ALTER TABLE usage_events_legacy RENAME CONSTRAINT usage_events_pkey TO usage_events_legacy_pkey;
CREATE TABLE usage_events (
    id                  bigint NOT NULL DEFAULT nextval('usage_events_id_seq'),
    time                timestamptz NOT NULL DEFAULT now(),
    request_id          text,
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
    settled             boolean NOT NULL DEFAULT false,
    pricing_group       text,
    group_ratio         double precision,
    model_ratio         double precision,
    completion_ratio    double precision,
    cache_ratio         double precision,
    model_price         double precision,
    PRIMARY KEY (id, time)
) PARTITION BY RANGE (time);
CREATE INDEX usage_events_time_idx ON usage_events (time);
CREATE INDEX usage_events_agg_idx ON usage_events (account_id, key_id, model, time);
CREATE INDEX usage_events_request_idx ON usage_events (request_id);
SELECT loom_ensure_month_partitions(
    'usage_events',
    coalesce((SELECT min(time) FROM usage_events_legacy), now()),
    now() + interval '3 months'
);
INSERT INTO usage_events (id, time, request_id, trace_id, span_id, account_id, key_id, model, provider, route, gateway,
                          input_tokens, output_tokens, cached_tokens, cost_nanos, gateway_cost_nanos, pricing_source,
                          settled, pricing_group, group_ratio, model_ratio, completion_ratio, cache_ratio, model_price)
SELECT id, time, request_id, trace_id, span_id, account_id, key_id, model, provider, route, gateway,
       input_tokens, output_tokens, cached_tokens, cost_nanos, gateway_cost_nanos, pricing_source,
       settled, pricing_group, group_ratio, model_ratio, completion_ratio, cache_ratio, model_price
FROM usage_events_legacy;
ALTER SEQUENCE usage_events_id_seq OWNED BY usage_events.id;
DROP TABLE usage_events_legacy;

-- 4. auth_audit 改为分区表，并支持聚合行：未识别出 Key 的拒绝按凭据前缀与分钟聚合，count 为合并的请求数。
ALTER TABLE auth_audit RENAME TO auth_audit_legacy;
ALTER INDEX auth_audit_time_idx RENAME TO auth_audit_legacy_time_idx;
ALTER TABLE auth_audit_legacy RENAME CONSTRAINT auth_audit_pkey TO auth_audit_legacy_pkey;
CREATE TABLE auth_audit (
    id                 bigint NOT NULL DEFAULT nextval('auth_audit_id_seq'),
    time               timestamptz NOT NULL DEFAULT now(),
    request_id         text NOT NULL DEFAULT '',
    client_request_id  text NOT NULL DEFAULT '',
    key_id             uuid,
    account_id         uuid,
    protocol           text NOT NULL DEFAULT '',
    model              text NOT NULL DEFAULT '',
    allowed            boolean NOT NULL,
    reason             text NOT NULL,
    credential_preview text NOT NULL DEFAULT '',
    count              int  NOT NULL DEFAULT 1,
    PRIMARY KEY (id, time)
) PARTITION BY RANGE (time);
CREATE INDEX auth_audit_time_idx ON auth_audit (time);
CREATE INDEX auth_audit_key_idx ON auth_audit (key_id, time);
SELECT loom_ensure_month_partitions(
    'auth_audit',
    coalesce((SELECT min(time) FROM auth_audit_legacy), now()),
    now() + interval '3 months'
);
INSERT INTO auth_audit (id, time, request_id, client_request_id, key_id, account_id, protocol, model, allowed, reason)
SELECT id, time, request_id, client_request_id, key_id, account_id, protocol, model, allowed, reason
FROM auth_audit_legacy;
ALTER SEQUENCE auth_audit_id_seq OWNED BY auth_audit.id;
DROP TABLE auth_audit_legacy;

-- 5. 日汇总表（按 UTC 日）与汇总水位线：水位线之前的日子查 usage_daily，之后查 usage_events。
CREATE TABLE usage_daily (
    day                date   NOT NULL,
    account_id         uuid   NOT NULL,
    key_id             uuid   NOT NULL,
    model              text   NOT NULL,
    requests           bigint NOT NULL,
    input_tokens       bigint NOT NULL,
    output_tokens      bigint NOT NULL,
    cached_tokens      bigint NOT NULL,
    cost_nanos         bigint NOT NULL,
    gateway_cost_nanos bigint NOT NULL,
    PRIMARY KEY (day, account_id, key_id, model)
);
CREATE INDEX usage_daily_account_idx ON usage_daily (account_id, day);
CREATE TABLE usage_rollup (
    singleton boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
    through   timestamptz NOT NULL -- 已汇总到此时刻之前（UTC 日边界，不含）
);

-- +goose Down
DROP TABLE usage_rollup;
DROP TABLE usage_daily;

ALTER TABLE auth_audit RENAME TO auth_audit_partitioned;
ALTER TABLE auth_audit_partitioned RENAME CONSTRAINT auth_audit_pkey TO auth_audit_partitioned_pkey;
ALTER INDEX auth_audit_time_idx RENAME TO auth_audit_partitioned_time_idx;
CREATE TABLE auth_audit (
    id                bigint PRIMARY KEY DEFAULT nextval('auth_audit_id_seq'),
    time              timestamptz NOT NULL DEFAULT now(),
    request_id        text NOT NULL DEFAULT '',
    client_request_id text NOT NULL DEFAULT '',
    key_id            uuid,
    account_id        uuid,
    protocol          text NOT NULL DEFAULT '',
    model             text NOT NULL DEFAULT '',
    allowed           boolean NOT NULL,
    reason            text NOT NULL
);
INSERT INTO auth_audit (id, time, request_id, client_request_id, key_id, account_id, protocol, model, allowed, reason)
SELECT id, time, request_id, client_request_id, key_id, account_id, protocol, model, allowed, reason
FROM auth_audit_partitioned;
ALTER SEQUENCE auth_audit_id_seq OWNED BY auth_audit.id;
DROP TABLE auth_audit_partitioned;
CREATE INDEX auth_audit_time_idx ON auth_audit (time);

ALTER TABLE usage_events RENAME TO usage_events_partitioned;
ALTER TABLE usage_events_partitioned RENAME CONSTRAINT usage_events_pkey TO usage_events_partitioned_pkey;
ALTER INDEX usage_events_time_idx RENAME TO usage_events_partitioned_time_idx;
ALTER INDEX usage_events_agg_idx RENAME TO usage_events_partitioned_agg_idx;
CREATE TABLE usage_events (
    id                  bigint PRIMARY KEY DEFAULT nextval('usage_events_id_seq'),
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
    settled             boolean NOT NULL DEFAULT false,
    pricing_group       text,
    group_ratio         double precision,
    model_ratio         double precision,
    completion_ratio    double precision,
    cache_ratio         double precision,
    model_price         double precision
);
INSERT INTO usage_events SELECT * FROM usage_events_partitioned;
ALTER SEQUENCE usage_events_id_seq OWNED BY usage_events.id;
DROP TABLE usage_events_partitioned;
CREATE INDEX usage_events_time_idx ON usage_events (time);
CREATE INDEX usage_events_agg_idx ON usage_events (account_id, key_id, model, time);

DROP FUNCTION loom_drop_month_partitions(text, timestamptz);
DROP FUNCTION loom_ensure_month_partitions(text, timestamptz, timestamptz);
DROP TABLE settled_requests;
