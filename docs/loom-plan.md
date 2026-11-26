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

对齐 Notion《vke 部署 agentgateway》的生产拓扑，按文件名顺序 apply：

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
