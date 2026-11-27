-- +goose Up
-- 结算依据：usage 按上游报告的用量计费；reserve_estimate 表示响应未完整结束（状态 2xx 却没有用量，
-- 多为客户端中途断开的流式请求），按准入时的预扣估值计费。
ALTER TABLE usage_events
    ADD COLUMN billing_basis text NOT NULL DEFAULT 'usage' CHECK (billing_basis IN ('usage', 'reserve_estimate'));

-- +goose Down
ALTER TABLE usage_events DROP COLUMN billing_basis;
