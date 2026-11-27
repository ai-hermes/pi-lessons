# loom 术语表

代码、配置、日志、指标统一使用以下术语；同一概念不使用同义词。

| 术语 | 代码中的名字 | 含义 |
| --- | --- | --- |
| 账户 Account | `store.Account` | 额度第一级；有分组（group）与状态。对外 header `x-loom-client-id` 携带的是**账户名**（历史契约名，不改） |
| API Key | `store.APIKey` | 调用方的 API Key，额度第二级；数据库只存 sha256 摘要（`store.HashAPIKey`） |
| 分组 Group | `Account.Group` | 决定分组倍率 `group_ratio`；必须在 `pricing.yaml` 的 `groups` 中定义（`default` 总是存在），否则按 `defaults.unknown_group` 处理 |
| 计价快照 Pricing Snapshot | `store.PricingSnapshot`、`usage_events.pricing_group` 等列 | 结算时使用的分组与倍率，用于复核每笔金额 |
| 准入 Admission | `admission.Gate.Admit` | 一次请求能否放行的判断：凭据 → Key → 状态 → 模型 → 定价 → 限流 → 预扣 |
| 结论 Verdict | `admission.Verdict` | 准入结果；`Reason` 是稳定枚举，拒绝时原样返回给调用方 |
| 价目表 Price Table | `pricing.PriceTable` | pricing.yaml + PG 兜底的运行时视图 |
| 单价 Unit Price | `pricing.UnitPrice` | 某 (model, group) 预计算的整数单价与预扣额 |
| 定价来源 Pricing Source | `pricing.PriceSource` | `configmap` / `pg` / `default` / `gateway`，落库到 `usage_events.pricing_source` |
| 账本 Ledger | `ledger.Ledger` | 额度的预扣、结算、过期释放 |
| 预扣 Reservation / Hold | `ledger.ReserveQuota` → `ledger.ReservationHold`、表 `reservations` | 准入时按预估冻结的额度；免费请求也有预扣记录（金额 0），用于占用并发名额 |
| 限流 Rate Limits | `store.RateLimits`、`throttle.Limiter` | 客户级上限 `rpm` / `tpm` / `max_concurrency`，API Key 与账户两级；账户未配置的项取分组 `limits`。不同于 `transport/ratelimit`（那是网关 RLS 协议，用来结算） |
| 计数窗口 Rate Window | `throttle.Window`、表 `rate_counters` | RPM / TPM 的分钟固定窗口；TPM 准入按估值计入、结算按实际修正 |
| 进行中 In Flight | `APIKey.InFlight`、`Account.InFlight` | 未结算的预扣记录数，即当前并发；与 `reserved` 在同一条预扣 UPDATE 中条件递增 |
| 用量上报 Usage Report | `ledger.UsageReport` | 一次请求的实际 token 用量，来自某个通道 |
| 通道 Channel | `ratelimit.Channel`=`rls`、`otlp.Channel`=`otlp` | 用量上报的来源；RLS 是同步主通道，OTLP 是补账通道 |
| 结算 Settlement | `ledger.Settle`、表 `usage_events` | 按实际金额冲正预扣；同一 `request_id` 只结算一次 |
| 协议 Protocol | `admission.Request.Protocol` | extauth 门面协议：`http` / `grpc` |
| 数据面 / 运维面 | `server.listen` / `server.ops_listen` | `:8080` 只给网关；`:9090` 给运维与 Prometheus |
