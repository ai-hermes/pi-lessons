# loom 外挂鉴权与计费（extAuth + billing）部署与使用手册

## 一、概览

本页讲清楚 loom 在 `st2-aii` kind 集群中的部署、验证与日常运维：loom 作为 AgentGateway 的外挂鉴权与计费服务，按 one-api 口径的模型计价表在鉴权阶段预扣额度，在响应完成后经 RLS amend 同步结算，OTLP access log 作为补账通道。外挂鉴权的原理与协议细节参考 [AgentGateway 外挂 Auth（extAuth）部署与使用手册](./agentgateway-extauth.md)。

### 1.1 部署环境与访问入口

| 键 | 值 |
| --- | --- |
| 集群 | `st2-aii`（kind），集群名 `agentgateway`，宿主机 `192.168.16.62` |
| 命名空间 | `loom`（数据面 Gateway、loom、loom-mock、PostgreSQL）；controller 在 `agentgateway` |
| 数据面入口 | NodePort `30080` → 宿主机 `http://127.0.0.1:14001` |
| loom 端口 | `8080` 数据面（h2c，仅供网关）：extAuth HTTP `/check` 与 gRPC `ext_authz`、RLS 结算、OTLP 补账；`9090` 运维面：管理 API `/v1`、`/metrics`、`/healthz`、`/readyz`，`server.pprof: true` 时另有需要认证的 `/debug/pprof` |
| 宿主机工具 | `/opt/agentgateway/k8s/bin/{kind,kubectl,helm}`、`docker`；无 go |
| 部署目录 | 宿主机 `/opt/agentgateway/loom/{build,k8s,configs}` |
| 本机入口 | `apps/loom`，`deploy/deploy.sh` 一键交叉编译 + 部署，`deploy/smoke.sh` 执行验收矩阵 |

### 1.2 版本与制品基线

| 键 | 值 |
| --- | --- |
| Go | `1.26`（本机交叉编译 `linux/amd64`，`CGO_ENABLED=0`） |
| agentgateway | `v1.7.0`（`cr.agentgateway.dev/agentgateway:v1.7.0`） |
| loom 镜像 | `loom/loom:<tag>`，`FROM busybox:stable`，`kind load docker-image` 注入 |
| 依赖 | `gin v1.12.0`、`pgx/v5 v5.13.0`、`goose/v3 v3.30.1`、`sqlc v1.31.1`、`client_golang v1.25.0`、`golang-lru/v2 v2.0.7`、`koanf/v2 v2.4.1`、`grpc v1.85.0` |
| 数据库（`--pg single`） | PostgreSQL 15（`postgres:15-alpine`，PVC `loom-postgres`），开发演示用 |
| 数据库（`--pg cnpg`） | CloudNativePG `1.30.2` 集群 `loom-pg`：PostgreSQL 18（`ghcr.io/cloudnative-pg/postgresql:18.7-minimal-trixie`）一主两从、`ANY 1` 同步复制，应用连 `loom-pg-rw` |
| 备份 | Barman Cloud 插件 `v0.16.0` + cert-manager `v1.20.5`；对象存储为集群内 minio（`ghcr.io/ai-hermes/coze-dep-minio:2025.6.13`，桶 `loom-pg-backups`），WAL 持续归档，每日 03:00 基础备份，保留 7 天 |

构建产物在 `apps/loom/build/`（不入库），部署脚本在远端 `docker build` 后 `kind load`。

### 1.3 架构与请求路径

```txt
调用方 ──Authorization/x-api-key + JSON body──► Gateway loom-gateway
   │  extAuth(forwardBody) ──► loom :8080 /check（或 gRPC ext_authz，同一端口）
   │                              ① sha256 查 Key ② 状态 ③ 请求体 model 定价 ④ 白名单 ⑤ 两级额度原子预扣
   │                              ⑥ 放行：注入 x-loom-client-id / key-id / request-id / quota-remaining / model
   │  headerModifiers 删除 authorization / x-api-key
   ▼
AgentgatewayBackend(protocol=llm) → loom-mock ── usage ──┬─► rateLimit.global(unit=Tokens, cost=llm.*) amend ──► loom :8080 ──► 同步结算（主通道）
                                                           └─► access log(OTLP/gRPC) ──► loom :8080 ──► 补账（同一 request_id，先到先结算）
:9090 /metrics ──► Prometheus
```

端口与路径：`/v1/chat/completions` → `lab-chat`（LLM 后端）、`/pg/v1/chat/completions` → `lab-pg-chat`、`/v1/images/generations` 与 `/v1/embeddings` → `loom-mock:8080`、`/echo` 与 `/grpc` → `loom-mock:8080`。

## 二、安装部署

> 前提：本机可 `ssh 192.168.16.62`，宿主机已有 kind 集群 `agentgateway`、镜像 `busybox:stable` 与 `postgres:15-alpine`。每完成一个步骤就执行对应检查，不要等所有命令执行完后再统一排错。

### 2.1 本地构建与单测

```bash
cd apps/loom
make test vet
```

**通过标准：** `go test ./...` 三个包（`auth`、`billing`、`pricing`）全部 `ok`，`go vet` 无输出。

### 2.2 一键部署

```bash
cd apps/loom
deploy/deploy.sh --fresh --tag v0.3.0
```

`--fresh` 会先删除 `loom` 与 `agentgateway-demo` 两个命名空间（controller 所在 `agentgateway` 保留），再按顺序执行：交叉编译 → `scp` 到宿主机 → `docker build` → `kind load` → `kubectl apply` → 从 `configs/` 生成 ConfigMap → 等待 rollout → 执行 seed Job。

**通过标准：** 脚本末尾打印 `deployed loom/loom:<tag>`，且输出中 `job.batch "loom-seed" condition met`。

如果 seed Job 失败，先不要改清单，优先检查：`kubectl -n loom logs job/loom-seed` 里的 DSN 是否指向 `loom-postgres`、`/etc/loom/seed.yaml` 是否挂载。

### 2.3 CloudNativePG 形态

生产形态用 CloudNativePG。平台组件（cert-manager、operator、Barman Cloud 插件）是集群级的，只需安装一次：

```bash
cd apps/loom
deploy/cnpg/install.sh             # 本机按固定版本下载上游清单，scp 后 apply 并等待就绪
deploy/deploy.sh --pg cnpg --tag v0.7.1
```

`--pg cnpg` 会在 `loom` 命名空间创建 minio 与 `loom-pg` 集群、把 `pg-dsn` 指向 `loom-pg-rw`，并删除单实例 `loom-postgres`。之后不带 `--pg` 时沿用集群里的现有形态；显式切回 `--pg single` 会删除 `loom-pg` 与 minio（含备份）。

宿主机直接拉取 ghcr.io / quay.io 常超时。7 个镜像已归档在网盘 `bd://deploy/images/`（`manifest.tsv` 记录镜像引用、digest 与 SHA-256），按下面的方式离线导入 kind 节点：

```bash
# 本机：下载并校验（文件名见 manifest.tsv 中 cloudnative-pg、plugin-barman-cloud、cert-manager 开头的行）
bdpan cp bd://deploy/images/cloudnative-pg-1.30.2-amd64.tar ./
shasum -a 256 cloudnative-pg-1.30.2-amd64.tar   # 与 manifest.tsv 第 5 列一致
scp ./*.tar 192.168.16.62:/opt/agentgateway/loom/cnpg/images/
# 宿主机：kind load 处理不了多平台镜像，直接导入节点的 containerd
for f in /opt/agentgateway/loom/cnpg/images/*.tar; do
  docker exec -i agentgateway-control-plane ctr --namespace=k8s.io images import --snapshotter=overlayfs - < "$f"
done
```

```bash
ssh 192.168.16.62 'export PATH=/opt/agentgateway/k8s/bin:$PATH; kubectl -n loom get cluster loom-pg; kubectl -n loom get pods -l cnpg.io/cluster=loom-pg -L cnpg.io/instanceRole'
```

**通过标准：** `STATUS` 为 `Cluster in healthy state`，3 个实例 `2/2 Running`（PostgreSQL + 备份插件 sidecar），一个 `primary` 两个 `replica`；`kubectl -n loom get cluster loom-pg -o jsonpath='{.status.conditions}'` 中 `ContinuousArchiving=True`。

### 2.4 部署后检查

```bash
ssh 192.168.16.62 'export PATH=/opt/agentgateway/k8s/bin:$PATH; kubectl -n loom get pods,agentgatewaypolicy'
```

**通过标准：** `loom` 2/2、`loom-gateway` 1/1、`loom-mock` 1/1、`loom-postgres` 1/1（`cnpg` 形态为 `loom-pg-1..3` 与 `loom-minio`）Running，`RESTARTS` 为 0；9 条 `AgentgatewayPolicy` 均 `ACCEPTED=True ATTACHED=True`。

### 2.5 离线目录说明

```text
/opt/agentgateway/loom/
├── Dockerfile          # FROM busybox:stable，拷贝两个静态二进制
├── build/              # loom、loom-mock（linux/amd64）、catalog.json
├── configs/            # config.yaml、pricing.yaml、seed.yaml（ConfigMap 来源）
└── k8s/                # 00-namespace … 09-telemetry，按文件名顺序 apply
```

- `00-namespace`：Namespace `loom`
- `01-gateway`：Gateway `loom-gateway` + `AgentgatewayParameters`（NodePort `30080`、`modelCatalog` 引用 `loom-catalog`）
- `03-secret`：PG DSN、admin token（演示占位）
- `04-postgres`：PostgreSQL 15 + PVC
- `05-loom`：loom Deployment（2 副本 + PDB）+ Service + ServiceAccount
- `05b-seed-job`：幂等 seed Job
- `06-backends`：loom-mock + 两个 `AgentgatewayBackend`
- `07-routes`：6 条 HTTPRoute
- `08-policies`：extAuth（HTTP/gRPC）、凭据头清理、媒体限流、重试
- `09-telemetry`：Gateway 级 access log / tracing / metrics 标签

## 三、使用验证

### 3.1 验收矩阵

```bash
cd apps/loom
deploy/smoke.sh
```

矩阵共 126 项检查，覆盖：鉴权拒绝矩阵、按量计费与预扣、分组倍率、按次计费、PG 兜底定价、embeddings、并发预扣、凭据头清理、gRPC 门面、管理 API 与指标、ConfigMap 热加载、RLS 同步结算与单通道独立性、多副本缓存失效、管理面角色与审计、超时预算（PG 行锁下准入在截止时间内拒绝且无残留预扣）、客户级限流（RPM / TPM / 并发）、数据增长（分区、幂等表、日汇总、审计聚合）、FailClosed。两种 PG 形态都适用。脚本开头会通过管理 API 复位 `alice`、`erin` 的额度，可重复执行。

**通过标准：** 末行输出 `RESULT: PASS=126 FAIL=0`。

### 3.2 关键结果实测

| 检查项 | 结果 |
| --- | --- |
| 无凭据 / 未知 Key / 过期 Key | ✅，`401` `missing_credential` / `unknown_api_key` / `expired_api_key` |
| 停用账户 / 模型未定价 / 分组未定价 / 不在白名单 | ✅，`403` `client_inactive` / `model_not_priced` / `group_not_priced` / `model_not_allowed` |
| `alice` 额度 `$0.005`，预扣 `3,072,000` | ✅，两次 `200` 后第三次 `403 insufficient_quota`，`quota_used = 3,640,000`，`reserved = 0` |
| 金额一致性 | ✅，`usage_events.cost_nanos = gateway_cost_nanos = 1,820,000`（`in=1000 cached=200 out=500`） |
| `vera`（vip 0.9） | ✅，loom `1,638,000`；网关 `1,820,000`（catalog 是 1 倍价，对账时乘分组倍率后一致）；计价快照 `vip / 0.9` |
| 图片模型按次 `lab-image` | ✅，`40,000,000`；热加载改价后 `50,000,000` |
| 仅在 PG 表的 `lab-pg-only` | ✅，`200`，`pricing_source = pg`，`910,000` |
| `erin` 额度够 5 次，并发 20 次 | ✅，`200 ≥ 5`、`200 + 403 = 20`、`quota_used ≤ quota_limit`、每笔 `1,820,000` |
| RLS 同步结算 | ✅，非流式与流式请求均在响应后 1s 内由 `channel=rls` 入库；OTLP 随后到达被幂等键拦下并补写 `gateway_cost_nanos` |
| 单通道独立性 | ✅，移除 OTLP access log 策略后仅靠 RLS 仍能结算；恢复后两通道并存 |
| `/echo` 上游请求头 | ✅，无 `authorization` / `x-api-key`，有 `x-loom-client-id=dave` 与 `x-loom-request-id` |
| `/grpc` gRPC 门面 | ✅，与 HTTP 门面结论一致 |
| ConfigMap 热加载 | ✅，所有副本 ≤ 3min 生效，无需重启，`loom_pricing_reloads_total` 增长 |
| loom 副本缩到 0 | ✅，`403`（FailClosed），恢复后 `200` |

### 3.3 手工发起一次计费请求

```bash
ssh 192.168.16.62
curl -s http://127.0.0.1:14001/v1/chat/completions \
  -H 'Authorization: Bearer loom-demo-dave-000000000000000004' \
  -H 'content-type: application/json' \
  -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}'
sleep 4
kubectl -n loom exec deploy/loom-postgres -- psql -U loom -d loom \
  -c "select model, input_tokens, output_tokens, cached_tokens, cost_nanos, gateway_cost_nanos, pricing_source from usage_events order by id desc limit 3"
```

**通过标准：** 响应 `usage` 为 `1000/500/200`，`usage_events.cost_nanos = 1820000`，`gateway_cost_nanos` 相等。

### 3.4 当前边界与风险

- **结算双通道，先到先结算**：主通道是网关响应完成后的 RLS amend（同步，每请求一次 gRPC），OTLP access log 为补账。两者共用 `request_id` 幂等键，后到者不重复扣费、只补写网关金额用于对账。
- **RLS amend 的返回值网关不看**：loom 在 amend 结算失败时返回 `RateLimitResponse.Code = ERROR(3)` 并计 `loom_ledger_settle_errors_total{channel="rls"}`，只为在网关 trace 里留下痕迹，不影响请求（响应已完成）。
- **RLS amend 不重试**：网关源码里 amend 以 `tokio::spawn` 发出并忽略结果（`crates/agentgateway/src/http/remoteratelimit.rs`），loom 不可用期间该次结算会丢，此时依赖 OTLP 补账；两条通道都丢才会落到预扣过期释放（`loom_reservations_expired_total` 增长即为信号）。策略 `failureMode: FailOpen`，结算通道故障不影响转发。
- `extAuth.cache` 不能开启：命中缓存的请求不会预扣。
- 网关 `modelCatalog` 不表达分组倍率：对账与 `cost_source: gateway_prefer` 都先把网关金额乘上账户分组倍率，再与 loom 金额比较或直接扣费；`loom_ledger_cost_mismatch_total` 覆盖所有分组。
- 只按 token 计费的模型必须经 `AgentgatewayBackend(protocol=llm)` 转发才有 usage；普通 HTTP 透传的路由（如当前 `/v1/embeddings`）token 为 0、费用为 0。
- OTLP 补账通道可丢：ingest 队列满即丢弃并计 `loom_otlp_dropped_total`；按次计费的纯 HTTP 路由（如 `/v1/images/generations`）没有 `llm.*` 用量，仍只走 OTLP。
- 以 loom 计价表为准扣费（`billing.cost_source: loom`）；网关金额只做对账。

## 四、日常运维

### 4.1 查看状态和日志

```bash
kubectl -n loom get pods
kubectl -n loom logs deploy/loom --tail=100
kubectl -n loom port-forward svc/loom 9090:9090 && curl localhost:9090/metrics | grep ^loom_
```

**通过标准：** 日志中每条结论有 `request_id` / `key_id` / `reason` / `model`；`/metrics` 有 `loom_admission_decisions_total`、`loom_ledger_remaining_nanos`、`loom_ledger_reservations_open`。

### 4.2 管理 API

```bash
kubectl -n loom port-forward svc/loom 9090:9090
T=loom-admin-token-change-me
H="Authorization: Bearer $T"
curl -s -H "$H" localhost:9090/v1/accounts | jq
curl -s -H "$H" localhost:9090/v1/usage/summary | jq
curl -s -X POST -H "$H" -H 'content-type: application/json' localhost:9090/v1/accounts \
  -d '{"name":"acme","tenant":"t1","group":"vip","quota_limit_nanos":50000000000}'
curl -s -X POST -H "$H" -H 'content-type: application/json' localhost:9090/v1/keys \
  -d '{"account_id":"<uuid>","name":"prod","quota_limit_nanos":10000000000,"model_allowlist":["lab-model"]}'
```

创建 Key 的响应里 `plaintext` 只出现一次。`POST /v1/accounts/:id/topup` 增加额度上限；`POST /v1/accounts/:id/quota` 与 `POST /v1/keys/:id/quota` 直接设置上限/已用量并清空预扣（验收复位用）。三者都在同一事务中写入额度变更流水（操作者、变更前后的上限与已用量），用 `GET /v1/quota-adjustments?account_id=<uuid>` 或 `?key_id=<uuid>` 查询。

配置里的 `admin.token` 是引导 token（读写权限），只用于初始化与紧急情况；日常使用按角色签发的 token，明文只在签发时返回一次：

```bash
curl -s -X POST -H "$H" -H 'content-type: application/json' localhost:9090/v1/admin/tokens -d '{"name":"grafana","role":"read"}'
curl -s -H "$H" localhost:9090/v1/admin/tokens | jq                 # 列出（含已吊销），不含明文
curl -s -X DELETE -H "$H" localhost:9090/v1/admin/tokens/<uuid>      # 吊销，立即生效
curl -s -H "$H" localhost:9090/v1/admin/audit | jq                  # 管理操作审计（写操作，请求体已脱敏）
```

`read` 角色只能发 `GET` 请求，其余方法需要 `write` 角色；越权返回 `403`，token 无效或已吊销返回 `401`。

### 4.3 修改价格

ConfigMap 为主、PG 表兜底，两条路径都不需要重启：

```bash
kubectl -n loom create configmap loom-pricing --from-file=pricing.yaml=apps/loom/configs/pricing.yaml --dry-run=client -o yaml | kubectl apply -f -
curl -X PUT -H "$H" -H 'content-type: application/json' localhost:9090/v1/pricing/<model> -d '{"model_ratio":0.3,"completion_ratio":2,"cache_ratio":0.1}'
```

未传的倍率取 1，`0` 表示免费，负数返回 `400`；`pricing.yaml` 同口径（未填写取 `defaults`），负数会让本次加载失败并保留上一版价目表。

修改前先备份：`kubectl -n loom get configmap loom-pricing -o yaml > pricing.bak.yaml`。生效需 kubelet 同步 ConfigMap 卷（≤ 1 min）+ `pricing.reload_interval`（30s）。

**回滚路径：** `kubectl apply -f pricing.bak.yaml`；PG 行用 `DELETE /v1/pricing/<model>`。

### 4.4 故障切换与备份恢复

CloudNativePG 自动处理主库故障：从库提升为主库，`loom-pg-rw` 跟随新主库，loom 连接池自动重连，无需人工介入。切换期间准入按 FailClosed 返回 `500 internal_error`。用演练脚本复核：

```bash
deploy/cnpg/drill.sh failover     # 持续请求中强制删除主库 Pod（模拟节点宕机）
deploy/cnpg/drill.sh switchover   # 正常删除主库 Pod（模拟滚动升级、节点排空）
deploy/cnpg/drill.sh restore      # 按需备份 → 时间点前后写标记 → 恢复到独立集群 loom-pg-restore → 核对
```

**通过标准：** 末行 `RESULT: ... FAIL=0`。st2-aii 实测基线：

| 场景 | 新主库提升 | 错误窗口 | 说明 |
| --- | --- | --- | --- |
| 强制删除主库 | 约 `20 s` | 约 `21 s` | 其中约 `16 s` 等旧主库租约过期（防脑裂） |
| 正常删除主库 | 约 `18 s` | 约 `9 s` | 先 `15 s` smart shutdown，期间已有连接照常服务 |
| 按需基础备份 | — | — | 约 `10 s` |
| 时间点恢复到新集群 | — | — | 约 `50 s` |

真实恢复（误删数据、逻辑损坏）不要覆盖原集群：参照 `drill.sh` 中 `loom-pg-restore` 的清单新建集群，`bootstrap.recovery.recoveryTarget.targetTime` 设为事故前的时间点，核对数据后把 `loom-secrets` 的 `pg-dsn` 改指 `loom-pg-restore-rw` 并重启 loom。

### 4.5 客户级限流

API Key 与账户两级都可以配置 `rpm`（每分钟请求数）、`tpm`（每分钟 token 数）、`max_concurrency`（同时进行中的模型请求数），不配置表示不限。账户未配置的项取 `pricing.yaml` 中所属分组的 `limits`：

```yaml
groups:
  trial: {ratio: 1, limits: {rpm: 60, tpm: 100000, max_concurrency: 4}}
```

单个账户或 Key 用管理 API 配置；`rate_limits` 整体替换三项，`{}` 表示全部取消：

```bash
curl -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"rate_limits":{"rpm":120,"max_concurrency":8}}' http://127.0.0.1:9090/v1/accounts/<account-id>
```

超限的请求返回 `429`，`x-loom-deny-reason: rate_limited`，`x-loom-rate-limit` 指出层级与限流项（如 `account/tpm`），`Retry-After` 给出建议等待秒数。账户与 Key 视图里的 `in_flight` 是当前进行中的请求数。指标 `loom_throttle_rejections_total{scope,limit}` 按层级与限流项统计拒绝次数。

**通过标准：** 配置后 `GET /v1/accounts/<id>` 返回的 `rate_limits` 与配置一致；`deploy/smoke.sh` 第 18 节全部 PASS。

### 4.6 数据保留与汇总

`usage_events`、`auth_audit` 按月分区；loom 每 `retention.interval`（默认 10 分钟）执行一轮维护：提前建好 3 个月的分区、把明细汇总进 `usage_daily`、按保留期删除过期分区与幂等记录。多副本时每个任务只由一个副本执行。

| 数据 | 保留期（配置项） | 默认 |
| --- | --- | --- |
| `usage_events` 明细 | `retention.usage_events_days` | `180` 天，按整月删除，且只删已汇总的部分 |
| `usage_daily` 日汇总 | 永久 | — |
| `auth_audit` 准入审计 | `retention.auth_audit_days` | `90` 天 |
| `settled_requests` 幂等记录 | `retention.settled_requests_days` | `7` 天，须大于 OTLP 补账的最大延迟 |

立即执行一轮（例如调整保留期后）：

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:9090/v1/admin/maintenance
```

**通过标准：** 返回的 `tasks` 中每项为 `ok` 或 `skipped`（另一副本正在执行）；`select through from usage_rollup` 为当天 UTC 零点。

用量汇总接口 `GET /v1/usage/summary` 对汇总水位线（当天零点）之前的日子查 `usage_daily`，`since` 早于水位线时按 UTC 日对齐。准入审计中未识别出 Key 的拒绝按分钟聚合，`count` 是合并的请求数，`credential_preview` 是凭据前 8 位（`*` 为溢出组）。

### 4.7 停止服务

```bash
kubectl -n loom scale deploy/loom --replicas=0
```

`failureMode: FailClosed` 下所有受保护路由会拒绝；恢复 `--replicas=2` 后自动放行。完全卸载：`kubectl delete ns loom`（PostgreSQL PVC 一并删除；`cnpg` 形态的 minio 备份也在该命名空间内，一并删除）。CloudNativePG 平台组件在 `cnpg-system`、`cert-manager` 命名空间，按需单独卸载。

## 五、FAQ

- 现象：所有请求 `401 missing_credential`。先查策略 `allowedRequestHeaders` 是否包含 `authorization` / `x-api-key`；常见原因是只配了 `path` 没配转发头。
- 现象：请求体里的 `model` 定价总是 `model_not_priced`。先查策略是否有 `forwardBody.maxSize`；没有它 loom 看不到请求体，`x-loom-model` 头也为空。
- 现象：`GET /echo` 返回 `405`。loom 的 `/check` 不限方法；若自建鉴权服务只注册 `POST /check`，网关对 GET 请求会以 GET 发起校验并被原样透传 `405`。
- 现象：同一 Key 连续请求第二次就 `403 insufficient_quota`，额度明明够。先查上一次的预扣是否已结算（`loom_ledger_reservations_open`、`reservations` 表）；常见原因是结算延迟未到就发了下一次，或 RLS 与 OTLP 都没送到 `:8080`（看 `loom_usage_events_ingested_total`）。
- 现象：RLS 没有结算、`loom_ratelimit_calls_total{phase="amend"}` 不增长。先查策略 `rateLimit.global.domain` 与 `ratelimit.domain` 是否一致（不一致 loom 直接返回 OK 不处理）；再查 `cost` CEL 是否引用了 `llm.inputTokens / cachedInputTokens / outputTokens`，以及请求头里是否有 extAuth 注入的 `x-loom-request-id`（extAuth 在限流之前执行）。
- 现象：`usage_events.gateway_cost_nanos` 为空。说明该行由 RLS 先结算且 OTLP 尚未到达或已丢；等 `flush_interval` 后仍为空即为补账通道丢失，看 `loom_ledger_settlements_total{channel="otlp",inserted="false"}` 是否增长。
- 现象：`loom_ledger_cost_mismatch_total` 增长。对账已经把网关金额乘过分组倍率，不一致说明价目不同源：先查 ConfigMap 与 `loom-catalog` 是否同源（`make catalog` 重新渲染），再用 `usage_events` 的计价快照（`pricing_group`、`group_ratio` 等列）复核单笔金额。
- 现象：Controller 报 Gateway `Programmed=False` 或 Deployment 冲突。Gateway 不能命名为 `loom`：controller 会以 Gateway 名创建同名 Deployment，与服务 Deployment 冲突；本环境用 `loom-gateway`。
- 现象：正常删除主库 Pod 后要等约 3 分钟才切换。先查 `loom-pg` 的 `smartShutdownTimeout`；默认 `180` 秒，smart shutdown 要等所有客户端断开，而 loom 连接池与 `LISTEN` 长连接不会主动断开，本环境设为 `15`。
- 现象：按需备份要 4～5 分钟才 `completed`。先查 ObjectStore `loom-pg-backups` 的 `data.immediateCheckpoint`；为 `false` 时备份要等下一次定时检查点（`checkpoint_timeout` 默认 5 分钟）。
- 现象：告警 `LoomReserveCompensationFailed`。准入预扣的提交确认丢失（多见于主库切换），且 30 秒内补偿释放没成功；这些预扣会在 `reservation_ttl` 后由 reaper 释放，期间相关账户可用额度偏少。确认 PG 已恢复即可，无需人工改账；急需时查 `reservations` 表中无对应 `usage_events` 的记录。
- 现象：宿主机拉取 `ghcr.io/cloudnative-pg/*` 或 `quay.io/jetstack/*` 长时间无进度。从网盘 `bd://deploy/images/` 离线导入，见 2.3。
- 现象：配置了 TPM 后请求总是 `429 api_key/tpm` 或 `account/tpm`。先查 `tpm` 是否小于单次预扣估值（`reserve_tokens` 的输入 + 输出，默认 2,048）；准入按估值计入，上限小于估值时任何请求都无法通过。
- 现象：`in_flight` 长时间不归零、并发名额被占满。先查是否有未结算的预扣（`reservations` 表）；正常情况下 RLS 在响应结束时结算，两条用量通道都没送达时要等 `reservation_ttl`（15 分钟）由 reaper 释放。
- 现象：某些用量明细的 token 全为 0，金额却等于预扣额，`billing_basis` 为 `reserve_estimate`。这是状态 2xx 却没有用量的响应（多为流式请求在最后的 usage chunk 前被客户端断开），按准入时的预扣估值计费，防止中途断开变成免费调用；`loom_ledger_incomplete_responses_total` 统计次数。如需按 0 结算，设 `ledger.incomplete_response: free`。
- 现象：断流请求的 `billing_basis` 为 `gateway_estimate`。网关开启了 provider 级 `tokenize`（需要支持流式用量估算的网关版本），按请求与已转发内容计数补上了用量，按估算的 token 计价；未开启时为 `reserve_estimate`。开启 tokenize 会让每个请求多一次计数，压测吞吐约降 15%。
- 现象：结算报 `no partition of relation "usage_events" found for row`。先查告警 `LoomMaintenanceFailing` / `LoomMaintenanceStale` 与指标 `loom_maintenance_runs_total{task="partitions"}`；分区维护连续失败超过提前量（3 个月）才会出现。处理：修复后执行 `POST /v1/admin/maintenance`。
- 现象：用量汇总比明细多。`usage_daily` 永久保留，明细超过保留期后被删除，汇总仍包含这些日子，属正常；核对单笔时只能在明细保留期内进行。
- 现象：某模型只改了 PG `model_pricing` 表但价格没变。先查 `GET /v1/pricing` 的 `pg` 段；PG 兜底有 `pricing_ttl`（30s）正缓存，管理 API 写入会主动清缓存，直接改库需等缓存过期。
