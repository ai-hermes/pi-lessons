-- +goose Up
-- 结算时的计价快照：按哪个分组、哪些倍率计价。全部可空，NULL 表示模型未定价（cost_nanos 为 0）。
ALTER TABLE usage_events
    ADD COLUMN pricing_group    text,
    ADD COLUMN group_ratio      double precision,
    ADD COLUMN model_ratio      double precision,
    ADD COLUMN completion_ratio double precision,
    ADD COLUMN cache_ratio      double precision,
    ADD COLUMN model_price      double precision;

-- +goose Down
ALTER TABLE usage_events
    DROP COLUMN pricing_group,
    DROP COLUMN group_ratio,
    DROP COLUMN model_ratio,
    DROP COLUMN completion_ratio,
    DROP COLUMN cache_ratio,
    DROP COLUMN model_price;
