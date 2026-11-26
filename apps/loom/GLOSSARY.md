# loom 术语表

代码、配置、日志、指标统一使用以下术语；同一概念不使用同义词。

| 术语 | 代码中的名字 | 含义 |
| --- | --- | --- |
| 账户 Account | `store.Account` | 额度第一级；有分组（group）与状态。对外 header `x-loom-client-id` 携带的是**账户名**（历史契约名，不改） |
| Key | `store.Key` | 调用方的 API Key，额度第二级；数据库只存 sha256 摘要（`store.HashAPIKey`） |
| 分组 Group | `Account.Group` | 决定分组倍率 `group_ratio` |
| 准入 Admission | `admission.Gate.Admit` | 一次请求能否放行的判断：凭据 → Key → 状态 → 模型 → 定价 → 预扣 |
| 结论 Verdict | `admission.Verdict` | 准入结果；`Reason` 是稳定枚举，拒绝时原样返回给调用方 |
| 价目表 Price Table | `pricing.Table` | pricing.yaml + PG 兜底的运行时视图 |
| 单价卡 Card | `pricing.Card` | 某 (model, group) 预计算的整数单价与预扣额 |
| 定价来源 Pricing Source | `pricing.Source` | `configmap` / `pg` / `default` / `gateway`，落库到 `usage_events.pricing_source` |
| 账本 Ledger | `ledger.Ledger` | 额度的预扣、结算、过期释放 |
| 预扣 Reservation / Hold | `ledger.Reserve` → `ledger.Hold`、表 `reservations` | 准入时按预估冻结的额度 |
| 用量上报 Usage | `ledger.Usage` | 一次请求的实际 token 用量，来自某个通道 |
| 通道 Channel | `ratelimit.Channel`=`rls`、`otlp.Channel`=`otlp` | 用量上报的来源；RLS 是同步主通道，OTLP 是补账通道 |
| 结算 Settlement | `ledger.Settle`、表 `usage_events` | 按实际金额冲正预扣；同一 `request_id` 只结算一次 |
| 协议 Protocol | `admission.Request.Protocol` | extauth 门面协议：`http` / `grpc` |
| 数据面 / 运维面 | `server.listen` / `server.ops_listen` | `:8080` 只给网关；`:9090` 给运维与 Prometheus |
