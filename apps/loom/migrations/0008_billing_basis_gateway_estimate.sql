-- +goose Up
-- gateway_estimate：上游没有报告用量（流在最后的 usage chunk 前被中断），由网关按已转发内容计数（tokenize）估算。
ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_billing_basis_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_billing_basis_check
    CHECK (billing_basis IN ('usage', 'reserve_estimate', 'gateway_estimate'));

-- +goose Down
UPDATE usage_events SET billing_basis = 'usage' WHERE billing_basis = 'gateway_estimate';
ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_billing_basis_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_billing_basis_check
    CHECK (billing_basis IN ('usage', 'reserve_estimate'));
