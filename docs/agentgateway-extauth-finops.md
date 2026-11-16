# agentgateway: BYO 外部鉴权与审计计费 — 设计与取舍

> 代码：`apps/agentgateway-lab/`（Go，单测 + 集群实跑）。本文只记录“为什么这样做”和“生产该怎么落”。

## 1. 问题

生产的 `ark-gateway` 用 Secret 里的 API key + `apiKeyAuthentication` 校验，限流用 `apiKey.client_id`。
这条路有三个上限：

1. key 必须落到 k8s Secret → 新增/轮转要 patch Secret，审计粒度只有 k8s RBAC。
2. 校验是纯本地哈希比较 → 无法做「预算耗尽、账号停用、会话、外部 IdP」这类状态判断。
3. 计费数据只在网关自己的日志里 → 对账/开票要另找来源。

## 2. 两个能力的边界

### 2.1 extAuth 做什么、不做什么

`extAuth` 是**唯一支持外部查找**的鉴权方式（`apiKeyAuthentication` 的字段只有
`configMapSelector / location / mode / secretRef / secretSelector`，没有远程调用）。

- 做：拒绝/放行、注入 identity header（`X-Client-Id` / `X-Plan` / `X-Budget-Remaining-Cents`…）、返回自定义状态码（401/403/429）。
- 不做：**精确计费**。extAuthz 只看得到请求，看不到响应里的 token 用量；把它当计费点必然会漏算/错算。
- 代价：每个请求多一次 RPC（同集群内 ~0.5–2ms），需要 `failureMode` 策略（默认建议 `FailClosed`）。

两个协议都实现了，因为客户存量系统不一样：

| 协议 | 适用 | CRD 字段 | 约定 |
| --- | --- | --- | --- |
| HTTP | 自研鉴权服务、复用现有 REST | `extAuth.http.path/body/allowedRequestHeaders` | 2xx = 允许，其他 = 拒绝，body 原样回给客户端 |
| gRPC | 已有 Envoy `ext_authz` 服务 | `extAuth.grpc.contextExtensions/requestMetadata` | `OK` = 允许，`Denied` + `DeniedHttpResponse` = 拒绝 |

`allowedRequestHeaders` 是这个功能最大的坑：默认只转发少量头，不显式列出 `authorization`/`x-api-key`/`x-session-token`
时，鉴权服务看到的是“无凭证”，表现为 100% `missing_credential`。

### 2.2 审计/计费为什么只能靠 telemetry

网关对每个 LLM 请求已经产出：

- `gen_ai.usage.input_tokens / output_tokens / cache_read.input_tokens`
- `agw.ai.usage.cost.total` + 分项（`cost.input` / `cost.output` / `cost.cache_read` …）
- `route`、`gateway`、`protocol=llm`、`lab.client.id`（我们加的 CEL 属性）

所以计费只需要把 telemetry 落到自己的库里，不需要旁路复制响应体。

```
Request → AgentGateway → extAuth（决策+identity）→ LLM
                ├── access log (OTLP) ─┐
                ├── traces     (OTLP) ─┼──► Collector（或直接 ingest）──► 审计/计费服务
                └── metrics  (Prometheus) ─┘         ├─ usage_events（计费）
                                                     └─ traces（争议取证）
```

## 3. 数据模型（PostgreSQL）

```sql
clients(client_id pk, tenant, plan, api_key_hash unique, status, budget_cents, spent_micros)
sessions(session_id pk, client_id, expires_at)
auth_audit(time, client_id, source, allowed, status, reason)      -- 每次决策一条
price_catalog(model, provider, input_micros, output_micros, cache_read_micros, discount, cached_at)
usage_events(time, request_id, client_id, tenant, model, provider,
             input_tokens, output_tokens, cached_tokens, realized_cost_micros, source)
traces(received_at, trace_id, span_id, name, service, route, client_id, model,
       duration_ms, status_code, cost_micros, input_tokens, output_tokens, attrs jsonb)
```

要点：

- **整数 micro-USD**（`1e-6 USD`）：浮点累计会让月度账单对不上；catalog 的 `USD/1M tokens` 直接乘 1e6 存整数。
- `usage_events.realized_cost_micros` 优先取网关上报的 `agw.ai.usage.cost.total`，网关没报（未定价）时才回退本地 `price_catalog`。这样 chargeback 与网关 UI/指标天然一致。
- `auth_audit` 从 `Evaluate()` 统一发出：HTTP façade 和 gRPC façade 不会对同一请求给出不同审计结论；PG 写入是 buffered best-effort，满了就丢，绝不阻塞请求路径。
- `traces` 按 `(trace_id, span_id)` 去重，OTLP 重试不会重复计费。

## 4. 接口

| 端点 | 用途 |
| --- | --- |
| `POST /v1/logs`、`:9101` OTLP/gRPC Logs | access log 摄取（计费主路径） |
| `POST /v1/metrics`、`:9101` Metrics | 指标摄取（可选，Prometheus 已可直抓） |
| `:9101` OTLP/gRPC Traces | 链路审计 |
| `GET /v1/usage/summary?since=&tenant=&client=` | 按 tenant/client/model 聚合 + 总成本 |
| `GET /v1/usage/chargeback` | 同上（语义别名，方便财务侧调用） |
| `GET /v1/traces/summary` | span 数 + 最近 10 条（identity/model/cost/延迟） |
| `GET /check`（extauth） | HTTP extAuth 契约 |
| `:9002` gRPC `AuthorizationServer.Check` | Envoy ext_authz v3 |
| `GET /admin/clients`、`POST /admin/clients` | 客户端生命周期（增改、停用、预算） |
| `GET /admin/jwt`、`GET /admin/session` | 只用于 lab 演示签发；生产应由 IdP / 登录服务签发 |

## 5. 生产落地建议

1. **身份**：`extAuth` 指向内网鉴权服务，返回 `X-Client-Id/X-Tenant-Id/X-Budget-Remaining-Cents`；
   `headerModifiers.request.remove` 里删掉 `x-api-key`/`authorization`，避免凭证继续流向模型供应商。
2. **限流**：extAuth 之后不再有 `apiKey.client_id`，`rateLimit.local.key` 改成 `request.headers["x-client-id"]`；
   跨副本要精确限流就别用 local（本地令牌桶不聚合），走外部网关/Redis 令牌桶。
3. **审计**：`accessLog.attributes.add` 注入 `lab.client.id`（或你的 `tenant.id`），
   OTLP 直发 Kafka/Collector；保留 `filter` 只发 LLM 流量，别把健康检查也灌进去。
4. **计费**：`modelCatalog` 放 Gateway 级 parameters（`infrastructure.parametersRef`），
   用 ConfigMap 热更新价格；`usage_events` 只信 `agw.ai.usage.cost.total`，本地 catalog 只作兜底。
5. **可靠性**：extAuth `FailClosed`（钱和权限优先），并给鉴权服务设 PDB/多副本；
   telemetry 链路要允许丢失（best-effort），不要让它反向影响转发路径。

## 6. 已验证 / 未验证

已验证（kind 集群 1.7.0，实跑）：

- HTTP + gRPC extAuth、FailClosed、identity 注入、审计落库；
- OTLP/gRPC access log → `usage_events`，realized cost 与网关日志一致（示例 1582 micro-USD）；
- OTLP/gRPC traces → `traces`，server span 带 client/model/cost/tokens；
- Prometheus `:15020/metrics`，`agentgateway_gen_ai_client_token_usage` 带 `gen_ai.*` 与自定义 `client_id` 标签；
- model catalog 热加载（ConfigMap → 无需重启）。

未验证 / 后续：

- 多副本下 local rate limit 的实际聚合行为（文档已说明不聚合）；
- Kafka/Collector 直连（lab 用 finops 直接收 OTLP，省掉一跳）；
- OTLP/HTTP（JSON）路径已实现并有单测，但集群里只跑了 gRPC 路径。
