# loom 实施计划：extAuth + billing（one-api 计价口径）

## 一、目标与范围

### 1.1 目标

在 `pi-lessons` 下新建应用 `apps/loom`（织机：把多家模型「编织」成一张网），作为 AgentGateway 的外挂鉴权（`extAuth`）与计费（billing）服务：调用方的 API Key 与额度不再落在网关 Secret 里，而是由 loom 在 PostgreSQL 中管理；每个请求按 one-api 口径的模型计价表算钱并从 Key 额度中扣除，额度不足时在鉴权阶段直接拒绝。

### 1.2 范围

- 范围内：API Key 鉴权（HTTP `/check` + Envoy `ext_authz` gRPC 双门面）、one-api 计价模型（ConfigMap 主 + PG 表兜底）、两级额度（账户 + Key）与预扣/结算、OTLP access log 计费入库、管理与用量查询 API、Prometheus 指标、K8s 部署物料、st2-aii 上的完整验证、运维文档。
- 范围外：真实模型供应商接入（用 `loom-mock` 伪 OpenAI 后端代替）、前端 UI、支付/充值流程、JWT/session 登录（保留扩展点，不实现）。

### 1.3 环境基线

| 键 | 值 |
| --- | --- |
| 目标环境 | `st2-aii` = `192.168.16.62` 上的 kind 集群 `agentgateway` |
| 现有命名空间 | `agentgateway`（controller，保留）；`agentgateway-demo`（旧 lab，**删除**） |
| 新命名空间 | `loom` |
| 数据面入口 | NodePort `30080` → 宿主机 `14001`（沿用现有 `AgentgatewayParameters`） |
| 宿主机工具 | `/opt/agentgateway/k8s/bin/{kind,kubectl,helm}`、`docker`；**无 go、无 psql** |
| 宿主机可用镜像 | `busybox:stable`、`postgres:15-alpine`（已 `kind load`）、`cr.agentgateway.dev/{agentgateway,controller}:v1.7.0` |
| 构建方式 | 本机 `go1.25 darwin/arm64` 交叉编译 `linux/amd64` → `scp` → 宿主机 `docker build`（`FROM busybox:stable`）→ `kind load docker-image` |
| agentgateway | `v1.7.0`，`extAuth` 支持 `forwardBody.maxSize`、`http.addRequestHeaders`（CEL）、`cache`、`conditional` |

## 二、总体架构与请求链路

### 2.1 组件与端口

单二进制 `loom`，一个 Deployment（replicas 2 + PDB），按监听端口拆分职责：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| `9001` | HTTP | extAuth 门面 `POST /check`；探针 `/healthz` `/readyz` |
| `9002` | gRPC | Envoy `ext_authz.v3` 门面（同一决策引擎） |
| `9100` | HTTP | 管理 API（gin）：`/v1/keys`、`/v1/accounts`、`/v1/pricing`、`/v1/usage/*` |
| `9101` | gRPC | OTLP Logs ingest（access log / trace） |
| `9102` | HTTP | Prometheus `/metrics`、`pprof` |

### 2.2 鉴权链路（含模型提取与额度预扣）

```txt
调用方 ──Authorization/x-api-key + JSON body──► AgentGateway
   │  extAuth 策略：forwardBody.maxSize=1Mi
   │                 addRequestHeaders: x-loom-model = CEL body.model
   │                 allowedRequestHeaders: authorization, x-api-key, x-request-id
   ▼
loom /check（:9001）或 Check()（:9002）
   ① 凭据提取 → sha256 → 查 api_keys（LRU 缓存 30s / 负缓存 5s）
   ② 状态检查：active / disabled / expired
   ③ 模型定价：pricing 解析（ConfigMap → PG → unknown_model 策略）
   ④ 模型权限：key.model_allowlist
   ⑤ 额度预扣：原子 UPDATE（账户 + Key 两级），不足 → 403 insufficient_quota
   ⑥ 放行：200 + identity headers；审计落 auth_audit
   ▼
headerModifiers.request.remove: [authorization, x-api-key, x-loom-model]
   ▼
上游模型（AgentgatewayBackend / AgentgatewayModel 池）
```

放行时注入、并经 `allowedResponseHeaders` 回传网关的头：

| 头 | 用途 |
| --- | --- |
| `x-loom-client-id` | 账户/租户标识，限流 key 与 access log 归属 |
| `x-loom-key-id` | Key 标识 |
| `x-loom-request-id` | loom 生成的请求 ID（入站 `x-request-id` 存在则复用），用于计费结算时找到预扣记录 |
| `x-loom-quota-remaining` | 剩余额度（nano-USD），便于业务侧软降级 |
| `x-loom-deny-reason` | 仅拒绝时出现 |

### 2.3 计费链路

```txt
AgentGateway frontend.accessLog（OTLP/gRPC）
   attributes.add:
     loom.client.id   = request.headers["x-loom-client-id"]
     loom.key.id      = request.headers["x-loom-key-id"]
     loom.request.id  = request.headers["x-loom-request-id"]
   ▼
loom :9101 ingest
   ① 过滤 protocol=llm（可配），映射 gen_ai.usage.* / agw.ai.usage.cost.total / gen_ai.request.model
   ② 按 loom 计价表算 cost_nanos（权威值）；同时记录 gateway_cost_nanos 用于对账
   ③ 单事务：INSERT usage_events（request_id 幂等）+ 结算预扣（used = used − reserve + actual）
   ▼
GET /v1/usage/summary | /v1/usage/chargeback（按 client/key/model 聚合）
```

### 2.4 两条链路独立

`extAuth` 只看得到请求，看不到响应里的 token 用量，不能当计费点；计费走遥测链路（best-effort，不阻塞转发）。两者的唯一耦合点是 `x-loom-request-id`：鉴权阶段预扣、计费阶段结算。

### 2.5 与 agentgateway `modelCatalog` 的关系

`loom render-catalog` 子命令从同一份 `pricing.yaml` 生成网关 `catalog.json`，让网关自己算出 `agw.ai.usage.cost.total`。loom 以**自己的计价表为权威**扣额度，网关金额只做对账：两者不一致时打 `loom_cost_mismatch_total` 指标。原因：PG 兜底定价的模型不会出现在网关目录里，若以网关金额为准会漏扣。

## 三、计价模型（one-api 口径）

### 3.1 概念映射

| one-api 概念 | loom 字段 | 含义 |
| --- | --- | --- |
| `ModelRatio[model]` | `models.<m>.model_ratio` | 倍率，`1` = `$2 / 1M input tokens` |
| `CompletionRatio[model]` | `models.<m>.completion_ratio` | 输出 token 相对输入的倍率 |
| `CacheRatio` | `models.<m>.cache_ratio` | 命中缓存的输入 token 倍率 |
| `ModelPrice[model]` | `models.<m>.model_price` | 按次计费（USD/次），设置后优先于倍率（图片、视频等） |
| `GroupRatio[group]` | `accounts.group` × `groups.<g>.ratio` | 分组倍率（default 1、vip 0.9 …） |
| `quota` | `quota_*` 列，单位 **nano-USD** | one-api 为 `1 USD = 500000 quota`；loom 改用 `1 USD = 1e9 nano-USD`，整数运算无浮点漂移 |

### 3.2 公式

```txt
按 token 计费（nano-USD，整数，最后向上取整）：
  p_in    = round(model_ratio × group_ratio × 2000)     # ratio 1 ⇒ 2000 nano-USD/token
  p_cache = round(model_ratio × group_ratio × 2000 × cache_ratio)
  p_out   = round(model_ratio × group_ratio × 2000 × completion_ratio)
  cost    = (input − cached) × p_in + cached × p_cache + output × p_out

按次计费：
  cost    = round(model_price × group_ratio × 1e9)
```

示例：`model_ratio 0.5 / completion_ratio 2 / cache_ratio 0.1 / group 1`，伪后端固定返回 `in=1000, cached=200, out=500`：

`800×1000 + 200×100 + 500×2000 = 1,820,000 nano-USD = $0.00182`

### 3.3 pricing.yaml 示例（ConfigMap `loom-pricing`）

```yaml
defaults:
  model_ratio: 1
  completion_ratio: 1
  cache_ratio: 1
  unknown_model: deny            # deny | default：未定价模型拒绝还是按 defaults 计价
groups:
  default: {ratio: 1}
  vip:     {ratio: 0.9}
models:
  doubao-seed-2.1-lite:       {model_ratio: 0.15, completion_ratio: 2, cache_ratio: 0.1}
  doubao-seed-2.1-pro:        {model_ratio: 1.2,  completion_ratio: 3, cache_ratio: 0.1}
  doubao-embedding-vision:    {model_ratio: 0.05}
  doubao-seedream-5.0-pro:    {model_price: 0.04}        # 按次
  doubao-seedance-2.5:        {model_price: 0.5}         # 按次
```

（示例数值仅用于验证，上线前替换为真实价格。）

### 3.4 解析顺序与热加载

- 查找顺序：`pricing.yaml`（ConfigMap 挂载 `/etc/loom/pricing.yaml`）→ PG `model_pricing` 表（管理员临时加价）→ `defaults.unknown_model` 策略。
- 启动时加载一次；之后每 `reload_interval`（默认 `30s`）对比文件 `mtime/sha256` 变化即重建 `PriceCard` 表（每个 `(model, group)` 预计算三个整数单价）。
- 每次查找打点 `loom_pricing_lookups_total{source=configmap|pg|default|miss}`。

## 四、额度与预扣

### 4.1 两级额度

| 表 | 列 | 说明 |
| --- | --- | --- |
| `accounts` | `quota_limit`、`quota_used`、`reserved`、`group` | 账户总额度，`NULL` = 不限 |
| `api_keys` | `quota_limit`、`quota_used`、`reserved`、`model_allowlist`、`expires_at` | Key 级限额，`NULL` = 跟随账户 |

预扣时两级都要通过；结算时两级同时累加。

### 4.2 预扣（auth 阶段，one-api pre-consume）

- 按量模型：`reserve = reserve.input_tokens × p_in + reserve.output_tokens × p_out`（默认 `1024/1024`，可按模型覆盖 `reserve_tokens`）。
- 按次模型：`reserve = model_price × group_ratio × 1e9`。
- 原子 SQL（两级各执行一次，`rowsAffected = 0` 即拒绝）：

```sql
UPDATE api_keys
SET reserved = reserved + $1
WHERE id = $2 AND status = 'active'
  AND (quota_limit IS NULL OR quota_limit - quota_used - reserved >= $1);
```

- 预扣记录写 `reservations(request_id, key_id, model, nanos, expires_at)`；`x-loom-request-id` 带回网关。

### 4.3 结算（billing 阶段，post-consume）

```txt
BEGIN
  INSERT usage_events(... request_id 唯一 ...) ON CONFLICT DO NOTHING
  UPDATE api_keys  SET quota_used = quota_used - r + actual, reserved = reserved - r WHERE id = key_id
  UPDATE accounts  SET quota_used = quota_used - r + actual, reserved = reserved - r WHERE id = account_id
  DELETE reservations WHERE request_id = $1
COMMIT
```

- 无预扣记录（鉴权时未预扣 / 已过期释放）：直接 `quota_used += actual`。
- 后台 reaper 每 `1m` 释放 `expires_at < now()` 的预扣（`reserved -= r`，计 `loom_reservations_expired_total`）；默认 TTL `15m`。

### 4.4 拒绝码

| 场景 | HTTP | `x-loom-deny-reason` | body `code` |
| --- | --- | --- | --- |
| 无凭据 | `401` | `missing_credential` | `missing_credential` |
| Key 不存在 | `401` | `unknown_api_key` | `unknown_api_key` |
| Key 过期 | `401` | `expired_api_key` | `expired_api_key` |
| Key/账户停用 | `403` | `client_inactive` | `client_inactive` |
| 模型不在 Key 白名单 | `403` | `model_not_allowed` | `model_not_allowed` |
| 模型未定价（`unknown_model: deny`） | `403` | `model_not_priced` | `model_not_priced` |
| 额度不足 | `403` | `insufficient_quota` | `insufficient_quota` |

- body 采用 OpenAI 错误格式 `{"error":{"code","message","type"}}`，现有 SDK 可直接解析。
- 额度不足的状态码可配（`auth.deny_status.quota`）：默认 `403`（one-api 口径，不可重试）；若希望对齐 OpenAI 可改 `429`。

### 4.5 并发与超支边界

- 预扣是单条原子 `UPDATE`，并发请求不会同时越过额度；验证用例：额度只够 5 次、并发 20 次，恰好 5 次 `200`。
- 结算金额大于预扣时会出现「本单超支」（one-api 同样行为），下一请求会被拒；`reserve_tokens` 调大可收紧。
- 网关侧 `extAuth.cache` **不要开启**：开启后命中缓存的请求不会预扣。

## 五、配置模型

### 5.1 应用配置 `config.yaml`

```yaml
server:
  extauth_http_addr: ":9001"
  extauth_grpc_addr: ":9002"
  admin_addr: ":9100"
  otlp_grpc_addr: ":9101"
  metrics_addr: ":9102"
  shutdown_timeout: 15s
log:
  level: info                  # debug|info|warn|error
  format: json                 # json|text
postgres:
  dsn_file: /etc/loom/secrets/pg-dsn    # 也可用 env LOOM_POSTGRES_DSN
  pool: {min_conns: 2, max_conns: 20, max_conn_lifetime: 30m, statement_timeout: 5s}
migrations:
  dir: migrations              # embed.FS
  auto: true                   # 启动时 goose up
auth:
  header_sources: [authorization, x-api-key]      # Bearer xx / 裸 key
  cache: {enabled: true, ttl: 30s, negative_ttl: 5s, size: 10000}
  identity_headers:
    client_id: x-loom-client-id
    key_id: x-loom-key-id
    request_id: x-loom-request-id
    quota_remaining: x-loom-quota-remaining
  deny_status: {unknown_key: 401, inactive: 403, quota: 403}
  failure_mode: FailClosed     # 仅文档/清单语义，服务端不可用时网关行为
pricing:
  configmap_path: /etc/loom/pricing.yaml
  reload_interval: 30s
  pg_fallback: true
quota:
  reserve_tokens: {input: 1024, output: 1024}
  reservation_ttl: 15m
  reaper_interval: 1m
billing:
  cost_source: loom            # loom（权威）| gateway_prefer
  idempotency: [request_id]
  filters:                     # 只入库 LLM 流量，避免健康检查灌表
  - {attribute: protocol, equals: llm}
  ingest: {queue_size: 4096, batch_size: 200, flush_interval: 2s}
  attributes:                  # OTLP 属性名映射（以网关为准）
    input_tokens: gen_ai.usage.input_tokens
    output_tokens: gen_ai.usage.output_tokens
    cached_tokens: gen_ai.usage.cache_read.input_tokens
    gateway_cost: agw.ai.usage.cost.total
    model: gen_ai.request.model
    provider: gen_ai.provider.name
    request_id: loom.request.id
    client_id: loom.client.id
    key_id: loom.key.id
telemetry:
  metrics: {enabled: true}
  tracing: {enabled: false}
admin:
  token_file: /etc/loom/secrets/admin-token
```

- 所有配置项可用环境变量覆盖（`LOOM_<SECTION>_<KEY>`），敏感项只读文件或 Secret。
- `loom check-config` 子命令做校验并打印生效的 `PriceCard` 表。

### 5.2 K8s 侧配置模型（`deploy/k8s/`）

对齐生产部署拓扑，按文件名顺序 apply：

| 文件 | 内容 |
| --- | --- |
| `00-namespace.yaml` | Namespace `loom` |
| `01-gateway.yaml` | Gateway + `AgentgatewayParameters`（NodePort `30080`、`modelCatalog` 引用 `loom-catalog`） |
| `02-configmaps.yaml` | `loom-config`（`config.yaml`）、`loom-pricing`（`pricing.yaml`）、`loom-catalog`（`render-catalog` 产物）、`loom-postgres-init`（演示账户/Key 种子） |
| `03-secret.yaml` | PG DSN、admin token（仅占位，实际由部署脚本注入） |
| `04-postgres.yaml` | PostgreSQL 15 + PVC（空目录） |
| `05-loom.yaml` | Deployment（2 副本、资源、探针、PDB）+ Service（`9001/9002/9100/9101/9102`） |
| `06-backends.yaml` | `loom-mock`（伪 OpenAI：chat 非流式/流式、embeddings、images，token 数由请求确定性推导）+ `echo`；`AgentgatewayBackend`（`protocol=llm`） |
| `07-routes.yaml` | HTTPRoute `llm`（`/v1/chat/completions`、`/v1/embeddings`、`/v1/images/generations`）、`echo`、`grpc-echo` |
| `08-policies.yaml` | `llm` 路由 extAuth（`forwardBody.maxSize: 1Mi`、`addRequestHeaders: x-loom-model` CEL、`allowedRequestHeaders`、`allowedResponseHeaders`、`FailClosed`）；`echo` 路由 HTTP extAuth；`grpc-echo` 路由 gRPC extAuth；`headerModifiers.request.remove` 删凭据头；媒体路由 `rateLimit.local`（`x-loom-client-id`，10 rpm burst 2）；`retry`（429/5xx 4 次 100ms） |
| `09-telemetry.yaml` | Gateway 级 `accessLog.otlp`（attributes `loom.*`）、`tracing.otlp`、`metrics.attributes` → `loom:9101` |
| `10-serviceaccount.yaml` | SA + NetworkPolicy（仅网关 Pod 可访问 `9001/9002`，仅网关可访问 `9101`） |
| `README.md` | 安装、验证、回滚 |

## 六、数据模型

### 6.1 表

| 表 | 关键列 |
| --- | --- |
| `accounts` | `id uuid pk`、`name`、`tenant`、`group`、`status`、`quota_limit bigint null`、`quota_used bigint`、`reserved bigint`、`created_at` |
| `api_keys` | `id uuid pk`、`account_id`、`name`、`key_hash sha256 unique`、`key_preview`（前 8 位）、`status`、`model_allowlist jsonb null`、`quota_limit bigint null`、`quota_used bigint`、`reserved bigint`、`expires_at`、`last_used_at` |
| `reservations` | `request_id pk`、`key_id`、`account_id`、`model`、`nanos bigint`、`expires_at`、`created_at` |
| `usage_events` | `id bigserial`、`time`、`request_id unique null`、`trace_id`、`span_id`、`account_id`、`key_id`、`model`、`provider`、`route`、`input_tokens`、`output_tokens`、`cached_tokens`、`cost_nanos`、`gateway_cost_nanos`、`pricing_source`、`settled bool` |
| `auth_audit` | `time`、`request_id`、`key_id`、`source`、`model`、`allowed`、`status`、`reason` |
| `model_pricing` | `model pk`、`model_ratio numeric`、`completion_ratio numeric`、`cache_ratio numeric`、`model_price numeric null`、`enabled bool`、`updated_at` |
| `schema_migrations` | goose 版本表 |

索引：`api_keys(key_hash)`、`usage_events(time, account_id, key_id, model)`、`reservations(expires_at)`。

### 6.2 代码生成与迁移

- `sqlc.yaml`：`engine: postgresql`、`schema: migrations`、`queries: internal/store/queries`、`out: internal/store/pg`、`sql_package: pgx/v5`。
- `migrations/0001_init.sql …`：goose `embed.FS` 嵌入二进制，启动时 `auto: true` 自动升级；也可 `loom migrate up|down|status`。
- `internal/store` 定义接口，`pg`（sqlc 实现）与 `mem`（单测）各一份。

## 七、代码结构与选型

### 7.1 目录（golang-standards/project-layout）

```text
apps/loom/
├── cmd/
│   ├── loom/main.go            # serve | migrate | render-catalog | check-config | admin
│   └── loom-mock/main.go       # 伪 OpenAI 后端
├── configs/                    # config.yaml、pricing.example.yaml
├── migrations/                 # goose SQL
├── sqlc.yaml
├── internal/
│   ├── config/                 # koanf 加载、校验、默认值
│   ├── server/                 # 监听器编排、优雅退出、就绪探针
│   ├── auth/                   # decide.go / http.go / grpc.go / identity.go / audit.go
│   ├── quota/                  # reserve.go / settle.go / reaper.go
│   ├── pricing/                # model.go / loader.go / pg_fallback.go / catalog_render.go
│   ├── billing/                # otlp.go / map.go / ingest.go / usage.go
│   ├── store/                  # 接口 + queries/*.sql + pg(sqlc) + mem
│   ├── cache/                  # LRU TTL 封装
│   ├── telemetry/              # metrics.go / logger.go
│   └── admin/                  # 管理 API handlers
├── pkg/loom/                   # 对外类型：Pricing、Usage、Error、HTTP 状态常量
├── deploy/
│   ├── k8s/                    # 5.2 节清单
│   ├── docker/Dockerfile
│   └── smoke.sh                # 验收矩阵脚本
├── docs/loom-extauth-billing.md
├── Makefile                    # build / test / sqlc / migrate / cross / deploy
└── README.md
```

### 7.2 选型

| 项 | 选择 | 说明 |
| --- | --- | --- |
| Web | `gin-gonic/gin` | 管理 API + `/check` |
| PG 驱动 | `jackc/pgx/v5` + `pgxpool` | 池统计接入指标 |
| 迁移 | `pressly/goose/v3` | `embed.FS`，启动自动升级 |
| SQL | `sqlc-dev/sqlc` | `pgx/v5` 插件，编译期类型安全 |
| 日志 | `log/slog`（JSON） | 零依赖，结构化 |
| 缓存 | `hashicorp/golang-lru/v2/expirable` | Key 查找与 PriceCard 两级 LRU |
| 指标 | `prometheus/client_golang` | 自定义 + go/process collector |
| 配置 | `knadh/koanf/v2` | yaml + env 覆盖 |
| 测试 | `stretchr/testify` | 单测用 `mem` store；PG 集成测试通过 `LOOM_TEST_DSN` 按需跑 |
| Go | `1.25` | 与本机一致 |

## 八、可观测性

### 8.1 指标

| 指标 | 类型 | 标签 | 含义 |
| --- | --- | --- | --- |
| `loom_build_info` | gauge | `version,commit` | 版本 |
| `loom_auth_decisions_total` | counter | `source,reason,allowed` | 鉴权决策 |
| `loom_auth_duration_seconds` | histogram | `stage=evaluate\|db\|cache` | 鉴权延迟 |
| `loom_auth_cache_hits_total` | counter | `type=key\|negative\|pricing` | 缓存命中 |
| `loom_pricing_lookups_total` | counter | `source=configmap\|pg\|default\|miss` | 定价来源 |
| `loom_pricing_reload_total` | counter | `result` | 配置热加载次数 |
| `loom_quota_reserved_nanos` / `loom_quota_settled_nanos` | counter | `model` | 预扣 / 结算金额 |
| `loom_quota_remaining_nanos` | gauge | `account` | 账户余额（账户数可控，低基数） |
| `loom_reservations_open` / `loom_reservations_expired_total` | gauge / counter | — | 预扣存量 / 过期释放 |
| `loom_usage_events_ingested_total` | counter | `protocol,pricing_source` | 计费入库 |
| `loom_ingest_errors_total` | counter | `reason` | 入库失败 |
| `loom_ingest_queue_depth` / `loom_ingest_flush_duration_seconds` | gauge / histogram | — | 队列与批量落库延迟 |
| `loom_cost_mismatch_total` | counter | `model` | loom 与网关金额不一致 |
| `loom_pg_pool_acquires_total` / `loom_pg_acquire_duration_seconds` | counter / histogram | — | 连接池健康 |
| `go_*` / `process_*` | — | — | 运行时 |

### 8.2 日志字段

`time`、`level`、`component`、`request_id`、`key_id`、`account_id`、`model`、`reason`、`status`、`cost_nanos`、`pricing_source`、`trace_id`。凭据只打 `key_preview`，永不打明文。

### 8.3 告警（`PrometheusRule`，可选）

- 5 分钟鉴权 `unknown_api_key` 比例 > 20%
- `loom_ingest_errors_total` 速率 > 0
- `loom_cost_mismatch_total` > 0
- `loom_reservations_expired_total` 持续增长（遥测链路丢日志）
- `pgx` acquire P99 > 100ms

## 九、部署物料

- `deploy/docker/Dockerfile`：`FROM busybox:stable`，非 root，仅拷贝 `loom` / `loom-mock` 两个静态二进制。
- `deploy/k8s/*.yaml`：5.2 节。
- `deploy/smoke.sh`：在宿主机 `127.0.0.1:14001` 上跑验收矩阵，并 `kubectl exec` 查 PG 断言金额。
- `Makefile`：`cross`（交叉编译到 `bin/linux_amd64/`）、`image`（远端构建 + `kind load`）、`deploy`（按序 apply）、`smoke`。

## 十、验证方案（st2-aii）

### 10.1 清理

```bash
kubectl delete ns agentgateway-demo          # 仅删旧 lab；controller 所在 ns agentgateway 保留
kubectl -n agentgateway get deploy           # 预期 controller 仍 1/1
```

### 10.2 部署顺序

本机 `make cross` → `scp` 到 `192.168.16.62:/opt/agentgateway/loom/` → 远端 `docker build` + `kind load docker-image … --name agentgateway` → `kubectl apply -f deploy/k8s/0*.yaml`（逐文件）→ `kubectl -n loom get pods,agentgatewaypolicy`。

### 10.3 验收矩阵

| 用例 | 预期 |
| --- | --- |
| 无凭据 `/v1/chat/completions` | `401` `missing_credential` |
| 未知 Key | `401` `unknown_api_key` |
| 停用 Key | `403` `client_inactive` |
| 有效 Key，`model=doubao-seed-2.1-lite` | `200`；usage `in=1000 cached=200 out=500` |
| 同一请求金额 | `usage_events.cost_nanos = 1,820,000`；`api_keys.quota_used` 累加同值；`gateway_cost_nanos` 相等，`loom_cost_mismatch_total` 为 0 |
| Key 额度 `5,000,000`，连续请求 | 前两次 `200`，第三次 `403` `insufficient_quota`（剩余 < 预扣 `3,072,000`） |
| 额度够 5 次，并发 20 次 | 恰好 5 次 `200`，15 次 `403` |
| 图片模型 `doubao-seedream-5.0-pro`（按次） | `200`；`cost_nanos = 40,000,000` |
| 未定价模型 | `403` `model_not_priced` |
| 仅在 PG `model_pricing` 中存在的模型 | `200`；`pricing_source=pg` |
| 修改 ConfigMap 价格 | `30s` 内新请求按新价计费，无重启 |
| Key `model_allowlist` 不含请求模型 | `403` `model_not_allowed` |
| gRPC `ext_authz` 路由（`/grpc`） | 与 HTTP 门面结论一致 |
| loom 副本缩到 0 | `403 authorization failed`（FailClosed），恢复后 `200` |
| 上游请求头 | 不含 `authorization` / `x-api-key`（echo 后端断言） |
| `/metrics` | 8.1 节指标全部出现，`loom_auth_decisions_total` 按 reason 增长 |
| 重复投递同一条 access log | `usage_events` 不新增行，额度不重复扣 |

### 10.4 金额一致性核对

以 3.2 节示例价格与伪后端固定 token 数为准，核对三处：网关日志 `agw.ai.usage.cost.total=0.00182`、`usage_events.cost_nanos=1820000`、`api_keys.quota_used` 增量 `1820000`。

### 10.5 Prometheus 检查

`curl 127.0.0.1:14001` 之外，`kubectl -n loom port-forward svc/loom 9102:9102` 后 `curl localhost:9102/metrics | grep loom_`，对照 8.1 节逐项核对。

## 十一、实施步骤

| 阶段 | 内容 | 产出 / 通过标准 |
| --- | --- | --- |
| P0 脚手架 | 目录、`config`、slog、metrics、PG 池、goose 迁移、sqlc、`/healthz` `/readyz` | `go vet && go test` 通过；本地连 st2-aii PG 跑通迁移 |
| P1 鉴权 | 凭据提取、Key 查找 + LRU、状态、identity headers、HTTP + gRPC 门面、审计 | 单测覆盖拒绝码表；`forwardBody + CEL model` 在 st2-aii 上打通 |
| P2 定价 | `pricing.yaml` 加载与热加载、PG 兜底、PriceCard、`render-catalog` | 3.2 节示例金额逐位一致；catalog 与 ConfigMap 同源 |
| P3 额度 | 两级额度、原子预扣、结算、reaper、`insufficient_quota` | 并发用例恰好 5 次 `200` |
| P4 计费 | OTLP ingest、属性映射、幂等入库、结算事务、`/v1/usage/*` | 10.4 节三处金额一致 |
| P5 管理 API | 创建/停用 Key、充值、改 PG 定价、用量查询 | `curl` 全流程可操作 |
| P6 部署与验证 | 清单、`loom-mock`、Dockerfile、smoke 脚本、st2-aii 清理重建 | 10.3 节矩阵全绿 |
| P7 文档 | `docs/loom-extauth-billing.md`（概览→安装部署→使用验证→日常运维→FAQ）与 README | 文档命令可逐条复制执行 |

## 十二、待确认决策

- 额度不足的状态码：默认 `403 insufficient_quota`（one-api 口径，SDK 不重试）；是否改为 OpenAI 的 `429`？
- 扣费权威来源：默认以 loom 计价表为准、网关金额仅对账；是否需要「网关优先」？
- 预扣 token 默认值 `1024/1024` 是否合适（影响小额 Key 的可用次数）。
- 是否保留账户 + Key 两级额度，还是只保留 Key 级。
- 清理范围：仅删除 `agentgateway-demo` 命名空间，controller 所在 `agentgateway` 保留——确认。

## 十三、实施结果（2026-11-26）

- 已交付：`apps/loom`（gin + pgx v5 + goose + sqlc + slog + golang-lru + prometheus），标准 project layout；单测覆盖定价公式、拒绝矩阵、预扣/结算幂等、并发预扣。
- 已部署到 `st2-aii`：命名空间 `loom`（旧 `agentgateway-demo` 已删除，controller 保留），`deploy/deploy.sh --fresh` 可一键重建，`deploy/smoke.sh` 70 项验收全绿。
- 与计划的差异：
  - Gateway 命名为 `loom-gateway`（controller 以 Gateway 名创建同名 Deployment，不能与 loom 服务同名）。
  - 模型名来自 `forwardBody` 后的请求体解析（网关同时收到 `x-loom-model` 注入头，供 access log 以 `loom.model` 属性回传）。
  - 鉴权阶段的 `/check` 不限 HTTP 方法（网关对 GET 请求以 GET 发起校验）。
  - 网关 `modelCatalog` 不表达分组倍率，非 `default` 分组账户跳过对账指标。
  - 结算异步（`flush_interval 2s`），同一 Key 连续请求存在预扣未释放的短窗口；已记录在运维手册「当前边界与风险」。
- 运维手册：[docs/loom-extauth-billing.md](./loom-extauth-billing.md)。

## 十四、TODO：防止定价配置漂移

背景：`pricing.yaml`（loom 计价）与 `catalog.json`（网关 `modelCatalog`）目前是「一个源 + 一个构建产物」，但集群里同时存在 `loom-pricing` 与 `loom-catalog` 两个 ConfigMap，任何一侧被手工 `kubectl edit` 都会产生漂移，表现为看板金额与账单不一致。两条线并行推进，先做流程再做校验；在此之前账单以 loom 为准，网关金额只做对账。

### 14.1 流程：从源头消灭手工改 ConfigMap 的机会

- [ ] 定价变更只允许通过 Git 进行：修改 `apps/loom/configs/pricing.yaml` → PR → 合并后由 `deploy/deploy.sh`（非 `--fresh`）统一重新生成 `loom-pricing` 与 `loom-catalog`，禁止 `kubectl edit` 两个 ConfigMap；在 `deploy/k8s/README.md` 与运维手册「修改价格」一节写明，并给两个 ConfigMap 加注解 `loom.ansible/managed-by: deploy.sh`。
- [ ] 评估是否移除网关 `modelCatalog`（方案 A）：若生产看板不消费 `agw.ai.usage.cost.*`，从 `01-gateway.yaml` 删掉 `modelCatalog`、`deploy.sh` 不再生成 `loom-catalog`，smoke 删除两条对账断言，`render-catalog` 降级为可选工具。
- [ ] `deploy.sh` 在 apply 之前用 `loom check-config` 校验 `pricing.yaml` 可解析，并把 `pricing.yaml` 的 sha256 写进 `loom-pricing` 的注解，账单争议时可追溯到具体版本。
- [ ] PG 兜底定价（`model_pricing`）同样纳入流程：只允许通过管理 API `PUT /v1/pricing/<model>` 写入并记录操作审计（当前没有审计），禁止直接改库。

### 14.2 校验：漂移发生时能被发现

- [ ] loom 启动及每次热加载时，把 `RenderCatalog(spec)` 与挂载进来的 `loom-catalog` 逐模型比对，不一致则设置指标 `loom_catalog_drift{model}` = 1 并打 WARN 日志；需要把 `loom-catalog` 以只读方式挂进 loom Pod。
- [ ] `deploy/smoke.sh` 增加一项：对比 `kubectl get configmap loom-pricing` 的 sha256 与 `loom-pricing` 注解，以及 `loom-catalog` 与本地 `render-catalog` 输出是否一致。
- [ ] PrometheusRule：`loom_catalog_drift > 0` 持续 5 分钟告警；`loom_ledger_cost_mismatch_total` 增长率 > 0 告警（对账前网关金额已乘账户分组倍率，覆盖所有分组）。
- [ ] 为 `loom_ledger_cost_mismatch_total` 增加按 `pricing_source` 的拆分，区分「ConfigMap 漂移」与「PG 兜底模型本来就不在 catalog 里」两类情况。

## 十五、TODO：记账单位从 USD 改为 credit

背景：loom 账本里的「USD」只是记账刻度，不涉及结算或汇率。计划改为 credit，定义为 **1 credit = 1M 个基准 token**（`model_ratio = 1`、`group_ratio = 1` 的模型）。倍率体系、整数运算、预扣/结算/幂等逻辑全部不变，只换基准常数与命名。

| | 现在（USD 口径） | 改后（credit 口径） |
| --- | --- | --- |
| 基准价 | `ratio 1 = $2 / 1M tokens` | `ratio 1 = 1 credit / 1M tokens` |
| 内部单位 | nano-USD，`1 USD = 1e9 nano` | nano-credit，`1 credit = 1e9 nano` |
| 每 token 单价 | `model_ratio × group_ratio × 2000` | `model_ratio × group_ratio × 1000` |
| lab-model（0.5 / 2 / 0.1）1000/500/200 | `1,820,000 nano = 0.00182 USD` | `910,000 nano = 0.00091 credit` |
| 预扣 1024/1024 | `3,072,000` | `1,536,000` |
| 按次 `model_price` | USD / 次 | credit / 次 |

- [ ] `internal/pricing`：`NanosPerUSD` → `NanosPerCredit`（仍为 `1e9`），`nanosPerRatioToken` `2000` → `1000`；全仓库文案与字段注释从 USD 改为 credit（`*_nanos` 字段名可保留）。
- [ ] 管理 API 响应增加 `credits`（`nanos / 1e9`）便于阅读；`x-loom-quota-remaining` 头仍用 nano 整数。
- [ ] `render-catalog`（若保留网关 `modelCatalog`）需要 `credit_usd_price` 配置把 credit 换算成网关认的 `$/1M`；若按 14.1 方案 A 去掉 `modelCatalog`，此项作废。
- [ ] `configs/seed.yaml`、`deploy/smoke.sh` 的期望值按上表重算（alice 额度、erin 并发、vera 分组、lab-image 按次）。
- [ ] 按次计费模型在 credit 口径下的正式定价规则（如 `doubao-seedream-5.0-pro: {model_price: 20}` = 20 credit/次）由业务确定后更新 `pricing.yaml`。
- [ ] 文档：README、运维手册、`pricing.yaml` 头部注释统一改为 credit，并向用户说明「1 credit = 1M 基准 token」及各模型的倍率。

## 十六、实施结果：计费结算改为 RLS 同步通道（2026-11-26）

OTLP access log 是遥测链路（批量、可丢），不适合做账本的数据源。按 agentgateway 的 token 预算机制（PR #1498）改为：

- 网关策略 `traffic.rateLimit.global`（`unit: Tokens`，三个描述符 `cost: llm.inputTokens / cachedInputTokens / outputTokens`）。请求阶段的 check 调用 `hits_addend=0`，loom 恒返回 OK；响应完成后的 amend 调用带上归一化 token 数，loom 在 `:9004`（`envoy.service.ratelimit.v3`）同步结算。
- 描述符 entries 携带 `request_id / key_id / model`，来自 extAuth 注入的请求头，与预扣记录关联。
- OTLP 保留为补账：同一 `request_id` 先到先结算；后到者只补写 `gateway_cost_nanos` 用于对账（`loom_usage_settled_total{channel,inserted}`）。
- 源码确认的边界：amend 由 `tokio::spawn` 发出且忽略结果，无重试；流式响应由 `AmendOnDrop` 保证客户端断连也会上报。纯 HTTP 路由（按次计费）没有 `llm.*`，仍只走 OTLP。
- 验收：`deploy/smoke.sh` 83 项全绿，新增 RLS 同步入库（≤1s）、单通道独立性、双通道幂等与网关金额补写。并发预扣用例因同步结算释放预扣更快，断言改为「不超额且每笔金额正确」。

## 十七、实施结果：按能力分包与端口收敛（2026-11-26）

- 包结构：`auth / quota / billing / admin / server / cache / pkg/loom` 重组为 `admission`（准入）、`ledger`（预扣 / 结算 / 过期释放）、`pricing`、`account`（管理操作）、`transport/{extauth,ratelimit,otlp,adminapi}`（协议适配）、`app`（装配与生命周期）；业务包只依赖自己声明的窄接口。术语见 `apps/loom/GLOSSARY.md`。
- 端口：6 个收敛为 2 个——`8080` 数据面（h2c，gRPC 与 HTTP 按 Content-Type 分流，仅供网关）、`9090` 运维面（管理 API、指标、探针、pprof）。网关策略的 `backendRef` 全部指向 `loom:8080`。
- 修复的问题：管理 API 参数错误返回 500（改为 400/404/409）；memstore 账户重名返回 NotFound；`loom_pg_pool_acquires_total` 从未递增（改为读取 pgxpool 实时统计）；环境变量映射无法覆盖带下划线的键；`SetAccountQuota` / `SetKeyQuota` 清预扣与改额度不在同一事务。
- 数据库：迁移 `0002` 删除 `auth_audit.status`（可由 reason 推出）、`source` 改名 `protocol`。
- 指标统一按能力命名：`loom_admission_*`、`loom_ledger_*`、`loom_pricing_*`、`loom_ratelimit_*`、`loom_otlp_*`、`loom_store_*`。
- 质量门：`make test`（`-race`）、`make lint`（golangci-lint v2，0 issues）、staticcheck、deadcode 清零；非生成代码行宽 ≤ 120。
- 验收：滚动升级与 `--fresh` 清库重建两条路径，`deploy/smoke.sh` 均为 `PASS=82 FAIL=0`（指标清单合并掉重复的 `loom_usage_events_ingested_total`，其余 70 项检查不变）。

## 十八、实施结果：计价口径、分组与账单快照（2026-11-27）

- 取值口径与 one-api / new-api 对齐：`pricing.yaml`、PG `model_pricing`、管理 API `PUT /v1/pricing/:model` 中，倍率与 `model_price` 未填写取默认值，`0` 表示免费（免费请求不预扣），负数让配置加载失败或返回 `400`。`UnitPrice` 用 `PerCall` 显式标记按次计费，`model_price: 0` 表示按次免费。
- 分组：`default` 分组总是存在；新增 `defaults.unknown_group: deny | default`（与 `unknown_model` 共用 `UnknownPolicy`，默认 `deny`）。账户分组在管理 API 与 `seed` 写入时校验；准入时未定义的分组返回 `403 group_not_priced`；结算时遇到已被删除的分组按 `default` 分组结算。
- `cost_source: gateway_prefer` 改为网关金额 × 分组倍率；对账同样先乘分组倍率，`loom_ledger_cost_mismatch_total` 不再跳过非 `default` 分组。
- 精度：单 token 单价保留小数（`float64`），整笔请求算完只取整一次，预扣同理。
- 账单快照：迁移 `0003` 为 `usage_events` 增加 `pricing_group`、`group_ratio`、`model_ratio`、`completion_ratio`、`cache_ratio`、`model_price`（`store.PricingSnapshot`），模型未定价时为 `NULL`。
- 缓存：账户更新后清理当前副本的准入缓存（API Key 带账户快照）与结算归属缓存（`account.CacheInvalidator`），其他副本仍依赖 TTL，见 19.8。
- 工程：命名按领域统一（`APIKey`、`UnitPrice`、`PriceTable`、`ModelRate`、`ReservationHold`、`UsageReport`、`AgentGateway*`），golangci-lint 规则扩充为 40 个、版本固定为 `v2.15.0`，CLI 的配置加载统一在根命令 `PersistentPreRunE`。
- 验收：滚动升级（自动执行迁移 `0003`）与 `--fresh` 清库重建两条路径，`deploy/smoke.sh` 均为 `PASS=84 FAIL=0`（新增账单快照与管理 API 拒绝未定义分组两项）。

## 十九、生产化路线

前提：loom 以开源 + 咨询为主、自用为主。PG 不可用时准入全部拒绝（extAuth 保持 `FailClosed`）；商业化外围（门户、充值、发票）只保证扩展性，不实现；合规由运营方自行解决，不在本路线范围；计费漏洞类问题（流式断开、透支、双通道丢失）后续参考 new-api 处理。

### 19.1 推进顺序

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| A 先测量 | 压测基线、AgentGateway 契约测试、告警与看板 | 无 |
| B 地基 | 存储一致性测试与驱动配置、跨副本缓存失效、管理面加固、上游报错时立即释放预扣 | 无 |
| C 可用性 | CloudNativePG 清单与备份恢复演练、云 PG 兼容、Pod 反亲和、超时预算 | B |
| D 性能与限流 | 合并 SQL 往返、准入限流、按压测结果决定是否做额度租约 | A |
| E 数据增长 | 拆出幂等表、按月分区、保留期清理、日汇总表 | B |

### 19.2 阶段 A：先测量

- [x] 压测：`deploy/bench.sh`（压测程序 `cmd/loom-bench`）经网关跑完整链路（准入 → mock 上游 → amend 结算），按并发分档记录端到端延迟、loom 准入耗时（`loom_admission_duration_seconds` 改为亚毫秒级桶）与每请求的 PG 写入。
- [x] AgentGateway 契约测试：`deploy/contract.sh` 覆盖正常、流式、上游 `503` / `400`、流式上游报错、客户端在结束 chunk 前断开 6 个场景，断言返回码、用量记录、金额、预扣释放与完成结算的通道（30 项）；`loom-mock` 通过请求头 `x-mock-status`、`x-mock-stream-chunks`、`x-mock-stream-delay-ms` 模拟异常。
- [x] 告警：`deploy/monitoring/loom-alerts.yaml`（11 条，覆盖可用性、PG、准入延迟与拒绝率、结算失败、预扣过期、OTLP 丢弃、对账不一致、价目热加载失败）；`deploy/monitoring/check.sh` 用 `promtool` 校验，并在 kind 中部署可选的最小 Prometheus（`deploy/monitoring/prometheus.yaml`）验证规则加载、指标存在与告警进入 `pending`（15 项）。标签取值固定的计数器（`loom_ledger_settle_errors_total{channel}`、`loom_pricing_reloads_total{result}`）启动时预建 0 值序列。
- [ ] 看板：Grafana 面板待有 Grafana 的环境再补。

压测基线（2026-11-27，st2-aii 单机 16 核，kind 中网关、loom 2 副本、PG 单实例与压测程序同机，mock 上游即时返回；数值只用于前后对比）：

| 场景 | 吞吐上限 | 端到端 p99（并发 8 / 32 / 64） | 准入 p99 上界（并发 8 / 32 / 64） |
| --- | --- | --- | --- |
| 单账户（1 个 Key） | 约 `800 rps` | `35` / `135` / `197` ms | `50` / `250` / `250` ms |
| 16 个账户轮询 | 约 `2,500 rps` | `29` / `53` / `73` ms | `25` / `50` / `100` ms |

- 并发 1 时两种场景都是约 `510 rps`、端到端 p50 `1.9 ms`、准入 ≤ `2 ms`。
- 每个模型请求约 `5`～`7` 个 PG 事务、`8`～`11` 行写入（含 OTLP 补账与准入审计）。
- 单账户吞吐只有多账户的三分之一，随并发上升的延迟主要在准入阶段，即账户行锁排队，对应 19.5。
- `2,500 rps` 时 OTLP 补账队列丢弃约一半上报；正常请求由 RLS 结算不受影响，但上游报错请求的预扣释放依赖 OTLP，见 19.9。
- 无效 Key 请求可达约 `18,800 rps`、准入 ≤ `0.5 ms`（负缓存生效），但每个被拒请求写一行 `auth_audit`，见 19.10。

### 19.3 可用性

- [x] PG 形态：`deploy/deploy.sh --pg single|cnpg`，不指定时沿用集群现有形态。`cnpg` 为 CloudNativePG `1.30.2` 集群 `loom-pg`：PostgreSQL 18 一主两从，`ANY 1` 法定人数同步复制（`dataDurability: preferred`，从库全部不可用时降级为异步），loom 连 `loom-pg-rw`；Barman Cloud 插件 `v0.16.0`（依赖 cert-manager `v1.20.5`）向对象存储持续归档 WAL 并每日基础备份，保留 7 天。平台组件由 `deploy/cnpg/install.sh` 安装一次；7 个镜像已归档到网盘 `bd://deploy/images/`（`manifest.tsv` 含 digest 与 SHA-256），宿主机拉取 ghcr.io 超时时离线导入。也允许直接使用云厂商 PG，只改 DSN。在 `cnpg` 形态下 smoke `104` 项、契约 `30` 项、store 一致性 `15` 组、监控 `16` 项全部通过。
- [x] 故障切换演练（`deploy/cnpg/drill.sh failover|switchover`，4 路并发持续请求中删除主库 Pod）：

| 场景 | 提升新主库 | 错误窗口 | 失败请求 | 账本校验 |
|------|-----------|---------|---------|---------|
| 强制删除（模拟节点宕机） | `20.4 s` | `20.7 s` | `65 / 8,064`，均为 `500 internal_error` | 通过 |
| 正常删除（模拟滚动升级、节点排空） | `18.1 s` | `9.4 s` | `40 / 13,451` | 通过 |

账本校验：每个成功请求恰好一条用量记录，`quota_used` 等于已结算用量之和，`reserved` 等于未结算预扣之和，无残留预扣。演练中的三个发现均已处理：

1. 强制删除时约 `16 s` 花在等待旧主库的 Kubernetes 租约过期（`primaryLease.leaseDurationSeconds` 默认 `15`），这是防脑裂的必要代价，保持默认。
2. 正常删除时 smart shutdown 会等所有客户端断开，而 loom 的连接池与 `LISTEN` 长连接不会主动断开，默认 `smartShutdownTimeout: 180` 使切换拖到 `185 s`；改为 `15` 后为 `18 s`。
3. 提交结果未知：预扣事务已在 PG 提交，但确认返回前准入截止时间已到，请求被拒绝而预扣留存，额度冻结到 `reservation_ttl`（`15 min`）。现在 `inTx` 把提交阶段的非服务端错误标记为 `store.ErrCommitOutcomeUnknown`，账本据此在后台按 `request_id` 幂等释放（`ReleaseReservation`，最长重试 `30 s` 以覆盖故障切换）；演练中补偿释放 `2` 笔，无残留。新增指标 `loom_ledger_reserve_compensations_total{result}` 与告警 `LoomReserveCompensationFailed`（共 13 条）。

- [x] 备份恢复演练（`deploy/cnpg/drill.sh restore`）：按需基础备份 `10 s`（ObjectStore 开启 `immediateCheckpoint`，否则要等下一次定时检查点，实测 `246 s`）；在目标时间点前后各写一个标记账户，按时间点恢复到独立集群 `loom-pg-restore` 用时 `50 s`，前一个标记存在、后一个不存在，账户数与源库在目标时间点一致。
- [x] loom 部署：`topologySpreadConstraints` 按节点打散；保留现有 PDB 与 `/readyz`（PG 不可用时摘除流量）。PG 实例开启 Pod 反亲和（演练集群只有一个节点，用 `preferred`；生产多节点改为 `required`）。
- [x] 超时预算：AgentGateway 对 extAuth 默认 `2s` 超时（`BackendRequestTimeout`）；loom 准入截止时间 `admission.timeout` 默认 `1500ms`，到期按 `500 internal_error` 拒绝并释放 PG 连接。
- [x] 预扣原子化：两级预扣与预扣记录合为一个事务（`ReserveQuota`，一条数据修改 CTE，任一级不满足时回滚）。修复前实测：PG 行锁使准入拖到网关 `2s` 超时，被取消的账户级预扣之后，API Key 级预扣的补偿撤销也因 context 已取消而失败，`3,072,000` nano 永久冻结（此时尚无预扣记录，reaper 无法释放）。`deploy/smoke.sh` 第 17 节在行锁下验证 `<2s` 返回 `500 internal_error` 且无残留冻结；store 一致性用例增加"两级预扣全有或全无"（含已取消的 context）。

### 19.4 存储可替换性（云 PG 与 MySQL）

- [x] 存储一致性测试：`internal/store/storetest` 的 22 组用例（账户与 API Key、条件预扣、两级预扣全有或全无、按请求释放预扣、限流配置读写、并发上限、额度重置两级一致、RPM / TPM 计数、结算幂等与冲正、过期释放、用量与计价快照、准入审计、兜底定价、额度变更流水、管理 token 与审计、幂等记录保留期、审计聚合行与清理、日汇总在明细删除后仍覆盖），`memstore` 在 `go test` 中运行，`postgres` 经 `deploy/conformance.sh` 在 st2-aii 的真实 PG 上（每次重建独立库 `loom_conformance`）运行，两者均通过；新增驱动以通过该测试为准入条件。统一后的语义：预扣金额大于 0 时，不存在的 API Key / 账户返回 `ErrInsufficientQuota`。限流的两个 PG 专有缺陷（在事务内读到本次未生效的递增、upsert 的 `EXCLUDED` 只能拿到截断后的值导致 TPM 负修正丢失）都是这套用例在真实 PG 上发现的，memstore 测不出来。
- [x] 配置 `store.driver`（当前只接受 `postgres`，其他值在配置校验阶段报错）。
- [x] `LISTEN` 使用可单独配置的直连 DSN（`postgres.listen_dsn`，为空时与主 DSN 相同），无法直连时退回 TTL 失效。
- [ ] 连接经过事务模式连接池（PgBouncer 等）时，提供配置切换为简单查询协议。
- [ ] PG 专有能力只出现在 `postgres` 实现内部，不改变 `store.Store` 方法语义：`RETURNING` / `ON CONFLICT`、带写操作的 CTE、`FOR UPDATE SKIP LOCKED`、`LISTEN` / `NOTIFY`、advisory lock、原生分区。MySQL 实现以多语句事务、`ON DUPLICATE KEY`、`GET_LOCK` 与轮询替代。

### 19.5 性能

- [x] 合并往返：准入的两级预扣与预扣记录合为一条 SQL（见 19.3）。复测：每请求 PG 事务数在 16 账户、并发 `8` / `32` / `64` 时由 `5.9` / `4.9` / `4.7` 降至 `3.7` / `2.9` / `2.5`，吞吐 `2,287` / `2,536` / `2,544 rps`（基线 `2,097` / `2,453` / `2,502`），并发 64 的 p99 由 `73 ms` 降至 `66 ms`；单账户吞吐仍约 `750`～`840 rps`，瓶颈是同一账户行的锁排队而不是往返次数。
- [ ] 额度租约（视压测结果）：每个副本向 PG 预领一段账户额度在内存扣减，用完再领、结算批量落库，用于缓解大账户的行锁热点。

### 19.6 限流

本地计数（网关本地限流、loom 内存计数）的实际上限等于单实例上限 × 实例数，扩缩容后无法预估，因此限流计数必须放在共享存储中。

- [x] 判定位置：在准入阶段（extAuth）完成，超限返回 `429 rate_limited`，响应头 `x-loom-rate-limit`（如 `account/rpm`）指出层级与限流项，`Retry-After` 给出重试等待（RPM / TPM 到窗口结束，并发 1 秒）；错误体 `type` 为 `rate_limit_error`。顺序为定价之后、预扣之前；随后被额度或并发拒绝时退回已计入的 RPM / TPM。
- [x] 计数后端：`internal/throttle` 定义 `Counter` 接口，第一版由 `store.Store` 的 PG 计数表 `rate_counters (subject, window_start)` 实现（迁移 `0005_rate_limits.sql`），过期窗口每分钟清理。准入计数是一条自动提交的有序 upsert，超限时逐行撤销；撤销与结算修正都是单行语句。初版用显式事务、修正一次更新两行，压测中与准入计数死锁，且热点行的锁跨 BEGIN / COMMIT 往返持有，单账户吞吐跌到约 `20 rps`，已按上述方式改正。
- [x] 配置：API Key 与账户上配置 `rate_limits {rpm, tpm, max_concurrency}`（管理 API、seed），未配置表示不限、配置值必须大于 0；账户未配置的项取 `pricing.yaml` 中所属分组的 `limits`，API Key 级不继承分组默认值。只有配置了 TPM 的层级才计 token，避免窗口中途开启 TPM 时带着未修正的估值起步。
- [ ] 网关本地限流只作为保护上游的安全阀（按上游总容量 ÷ 网关最大副本数取保守值），不用于客户级限额。

| 维度 | 实现 | 误差 |
| --- | --- | --- |
| RPM | PG 计数器，分钟窗口（需要更平滑时用双窗口加权） | 固定窗口边界处最多 2 倍，与副本数无关 |
| TPM | 准入时按 `reserve_tokens` 预估计入，结算时按实际 token 修正 | 限于预估与实际的差值，与副本数无关 |
| 并发数 | `api_keys` / `accounts` 的 `in_flight` 列与 `reserved` 在同一条预扣 UPDATE 中条件递增；免费请求也写预扣记录 | 精确，结算、补偿或过期释放时递减 |

验证：smoke 第 18 节（RPM 第 3 次 `429 api_key/rpm`；TPM 上限 4,000、每次估值 2,048、实际 1,500，第 2 次因结算修正得以放行、第 3 次 `429 api_key/tpm`；账户并发 2 时 3 路重叠流式请求为 `200 200 429`，结束后 `in_flight` 归零）；store 一致性新增 4 组（共 19 组）。

开销（st2-aii，CloudNativePG 同步复制，限额设得足够大、不触发拒绝，两级都配 RPM / TPM / 并发）：

| 场景 | 不限流 rps | 开启限流 rps | 每请求 PG 事务数 |
| --- | --- | --- | --- |
| 单账户，并发 8 / 32 / 64 | `338` / `531` / `537` | `246` / `272` / `293` | `3.8`～`6.9` → `6.6`～`10.0` |
| 16 账户，并发 8 / 32 / 64 | `2,194` / `2,400` / `2,377` | `1,274` / `1,948` / `1,892` | `2.3`～`2.9` → `5.4`～`6.4` |

多出的 PG 语句是每次准入 1 条计数、每次结算 2 条 TPM 修正（两级各一条）。单账户下账户计数行与账户额度行是两个热点，吞吐约降一半；多账户约降 20%，并发 64 的 p99 由 `65 ms` 到 `73 ms`。不配限额的账户没有任何额外开销。另：同步复制使单账户基线（约 `530 rps`）低于单实例 PG 时的约 `800 rps`。单账户若需要更高吞吐，下一步是额度与计数租约（19.5），或把计数后端换成 Redis（实现 `throttle.Counter` 即可）。

### 19.7 管理面安全

- [x] 管理 token（`internal/operator`，表 `admin_tokens`）：配置中的 `admin.token` 为引导 token（`write`）；其余 token 经 `POST /v1/admin/tokens` 签发，库中只存哈希，分 `read` / `write` 两种角色，`DELETE /v1/admin/tokens/:id` 吊销后立即生效（认证不缓存）。OIDC 暂不接入。
- [x] 管理操作审计（表 `admin_audit`，`GET /v1/admin/audit`）：每个写请求记录操作者、方法、路由、目标、脱敏后的请求体与响应码。
- [x] 额度变更流水（表 `quota_adjustments`，`GET /v1/quota-adjustments`）：`TopUp`、`ResetAccountQuota`、`ResetAPIKeyQuota` 在同一事务中锁行读取变更前的值、修改额度并写入流水（操作者、变更前后的上限与已用量），作为以后充值、退款、对账的基础。
- [x] pprof 默认关闭（`server.pprof`），开启后挂在管理 API 认证之后，需要 `read` 角色。
- [x] 验收：迁移 `0004` 在滚动升级中自动执行；`deploy/smoke.sh` 第 16 节验证读写角色、即时吊销、流水与审计中的操作者、pprof 默认关闭（smoke 共 99 项）。
- [ ] API Key 支持可选的 IP 白名单。

### 19.8 多副本一致性

- [x] `internal/cachesync`：管理操作（含 `seed`）写入成功后，先清理本副本缓存，再经 `Broadcast` 接口广播；PG 实现用 `LISTEN` / `NOTIFY`（频道 `loom_invalidate`，载荷 `{kind, id, origin}`，忽略自己发出的消息），覆盖 API Key、账户与兜底价格三类缓存。监听连接断开后指数退避重连（`1s`～`30s`），断开期间退回 TTL（准入 `5s`、结算归属 `60s`、兜底价格 `30s`）。指标 `loom_cache_invalidations_total{kind,origin}`、`loom_cache_sync_reconnects_total`，告警 `LoomCacheSyncReconnecting`。
- [x] 验收：`deploy/smoke.sh` 第 15 节在 2 副本上只经一个副本停用 Key，紧接着的 10 个请求全部 `403`，发起副本记 1 次 `local`、另一副本记 1 次 `remote`。

### 19.9 上游依赖（AgentGateway）

- [ ] 部署清单固定 AgentGateway 版本，升级前跑 19.2 的契约测试。
- [ ] 在运维手册中列出依赖的网关行为及源码出处（`crates/agentgateway/src/llm/mod.rs`、`http/remoteratelimit.rs`）。
- [x] 上游报错与客户端中途断开不依赖 OTLP：契约测试实测，这两类请求的 RLS amend 用量全为 `0`，loom 视同请求阶段忽略，由 OTLP 在 `1`～`2` s 内结算为 `0` 并释放预扣；OTLP 丢失时预扣冻结到 `reservation_ttl`（`15m`），而压测中高负载下 OTLP 会大量丢弃。已实施：网关策略增加 `kind=completion`、`cost: '1'` 的描述符，amend 时必然非 0，loom 据此由 RLS 立即按实际用量（失败时为 `0`）结算；契约测试中上游报错与客户端断开 4 个场景均由 `rls` 结算。

### 19.10 数据增长

- [x] 幂等改造：新表 `settled_requests (request_id PK, usage_time, settled_at)` 承担结算幂等，结算时先登记再写明细（一条 CTE）；`usage_time` 用于补写网关金额时定位分区（执行期剪枝）。超出保留期（默认 7 天）的重复上报不再能识别，保留期须大于 OTLP 补账的最大延迟。
- [x] 按月分区：`usage_events`、`auth_audit` 改为 `PARTITION BY RANGE (time)`，主键 `(id, time)`；分区由迁移中的 PL/pgSQL 函数 `loom_ensure_month_partitions` / `loom_drop_month_partitions` 建与删（PG 专有能力只在 `postgres` 实现内部），删除时当月及以后的分区永不删除。迁移 `0006_data_growth.sql` 把现有数据复制进分区表：st2-aii 上约 31 万 × 2 行用时约 20 秒，回滚约 12 秒，均在真实数据副本上演练过。超期明细导出到对象存储（Parquet）暂未实现。
- [x] 保留期清理：`internal/maintenance` 每 `retention.interval`（默认 10 分钟）按顺序执行建分区（提前 3 个月）→ 日汇总 → 删过期明细 → 删过期审计 → 清理幂等记录；多副本时每个任务用 `pg_try_advisory_xact_lock` 保证只有一个副本执行，其余记为 `skipped`。明细只删除已汇总过的部分（截止时间取保留期与汇总水位线中较早者），首次汇总覆盖全部历史明细。`POST /v1/admin/maintenance`（write 角色）可立即执行一轮。指标 `loom_maintenance_runs_total{task,result}`、`loom_maintenance_last_success_timestamp_seconds{task}`，告警 `LoomMaintenanceFailing`、`LoomMaintenanceStale`（共 15 条）。
- [x] 日汇总表 `usage_daily (day, account_id, key_id, model)` 永久保留；汇总接口改为“水位线之前查 `usage_daily`（`since` 按 UTC 日对齐），之后查明细”，汇总滞后也不漏数；每轮重算水位线前一天以吸收迟到的结算与补写。结算时间与当前时刻相差超过 1 小时（或超前 5 分钟）时按结算时刻记账，避免落进已汇总、不再重算的日子或不存在的分区。
- [x] 准入审计降噪：未识别出 Key 的拒绝（缺凭据、未知 Key、查 Key 出错）按“分钟 + 原因 + 凭据前 8 位 + 协议”在各副本内存中聚合成一行（`auth_audit.count`、`credential_preview`），每分钟最多 100 组，其余并入 `*` 溢出组；无效 Key 洪水因此最多放大为每副本每分钟 101 行。指标 `loom_audit_aggregated_requests_total`。

验证：smoke 第 19 节（3 个月后的分区已建好；结算登记了幂等记录；昨天的一条明细经立即维护汇总进 `usage_daily`，删除明细后汇总接口仍返回 `777`；20 次未知 Key 请求合计 `count` 为 20、每个副本至多一行）；store 一致性新增 3 组（共 22 组）；维护任务单测覆盖“先汇总后清理”“未汇总不清理”“其他副本执行时记为 skipped”。真实 PG 发现并修复两个问题：分区名后缀少取了一位（`right(name, 7)`），解析出错误的年份，所有分区都会被当作过期删除；结算时间为零值时写成公元 1 年（旧表一直如此，分区表直接报错）。

开销（st2-aii，16 账户）：吞吐由约 `2,400` 到约 `2,280 rps`（约 −4%），每请求多写 1 行（幂等记录）；单账户基本不变。

| 数据 | 保留期 | 说明 |
| --- | --- | --- |
| `usage_events` | `180` 天 | 覆盖月度对账与争议期；每行含索引约 `0.5 KB`（估算），每日 100 万请求约 `0.5 GB/天` |
| `usage_daily` | 永久 | 体积小，用于长期报表 |
| `auth_audit` | `90` 天，可配置 | 由第三方对公众运营时按日志留存要求调为 `180` 天 |
| 已结算请求表 | `7` 天 | 大于 OTLP 补账的最大延迟 |
| `reservations` | 不设 | 结算或过期即删除 |
| 管理操作审计、额度变更流水 | 永久 | 涉及资金，量小 |
| 应用日志 | `30` 天 | 由集群日志系统管理 |

### 19.11 商业化扩展点

- [ ] 额度变更流水（见 19.7）作为充值、退款、对账的地基。
- [ ] 金额统一经过一层单位换算，不在业务代码中写死 nano-USD，与第十五章 credit 方案衔接。
- [ ] 管理 API 是唯一集成面：门户等外部系统只通过管理 API 读写，不直接访问数据库。
- [ ] 结算成功后输出结构化事件（先写日志或 `NOTIFY`），以后接计费系统时不改账本。

### 19.12 真实上游验证

2026-11-27 在 st2-aii 上让 loom-gateway 直连火山方舟按量付费接口（`deploy/real/`），模型 `doubao-seed-2-0-lite-260428`（思考模型）与 `deepseek-v4-flash-ga-260731`，`deploy/real/run.sh` 23 项全部通过。

| 场景 | 结果 |
| --- | --- |
| 非流式、关闭思考、流式（两种写法）、DeepSeek | 客户端收到的 `usage`（输入 / 缓存 / 输出）与 loom 落库逐项一致；loom 金额与网关 catalog 金额一致；RLS 先结算，OTLP 到达后识别为重复并补写网关金额 |
| 上游 400（非法参数） | 网关记录 `http.status=400`，loom 按 0 结算，预扣立即释放 |
| TPM 上限 3,000、估值 2,048 | 实际约 40 token，结算修正后 3 次均放行（不修正时第 2 次即超限） |
| 账户扣减 | `accounts.quota_used` 等于本轮结算总额 |
| 准入耗时 | 约 `2.5 ms`；预扣 `921,600` nano，按实际结算（如 `310,800`）冲正 |

发现：

1. **客户端中途断开的流式请求按 0 结算（计费漏洞，待定策略）。** 方舟只在最后一个 chunk 返回 usage，客户端在此之前断开时，网关访问日志为 `http.status=200`、有首 token 耗时，但没有任何 token 数；loom 收到全 0 的用量，按 0 结算、释放预扣。上游通常仍对已生成的 token 计费（未在账单侧核实），调用方可借此免费使用。可区分的信号是“状态 2xx 且用量为 0”（上游报错时状态为 4xx/5xx）。可选策略：按预扣额结算（简单、偏保守，正常的“停止生成”也会被按估值计费）；只按输入估值结算；或由网关按已转发内容估算 token（需网关支持，new-api 的做法是对已收到的流式文本计数）。
2. **思考模型的 `max_tokens` 不约束思考 token。** `max_tokens: 60` 时输出 `611`～`683` token，其中思考 `562`～`633`；按输出计费正确，但全局预扣估值（输出 1,024）可能低于实际，此类模型宜在 `pricing.yaml` 中单独调大 `reserve_tokens`。
3. **流式请求即使未要求 usage，客户端也会收到 usage chunk**：网关为了计量向上游补上了 `stream_options.include_usage`，并原样转发给客户端；一般无害，个别严格的客户端可能需要兼容。
4. **前缀缓存未命中**：同一 1,242 token 前缀连发两次，`cached_tokens` 均为 0（方舟的 Chat Completions 不做隐式前缀缓存），缓存计价路径仍只有 mock 覆盖。
