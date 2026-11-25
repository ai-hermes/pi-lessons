# loom 外挂鉴权与计费（extAuth + billing）部署与使用手册

## 一、概览

本页讲清楚 loom 在 `st2-aii` kind 集群中的部署、验证与日常运维：loom 作为 AgentGateway 的外挂鉴权与计费服务，按 one-api 口径的模型计价表在鉴权阶段预扣额度、在遥测阶段结算。外挂鉴权的原理与协议细节参考 [AgentGateway 外挂 Auth（extAuth）部署与使用手册](./agentgateway-extauth.md)。

### 1.1 部署环境与访问入口

| 键 | 值 |
| --- | --- |
| 集群 | `st2-aii`（kind），集群名 `agentgateway`，宿主机 `192.168.16.62` |
| 命名空间 | `loom`（数据面 Gateway、loom、loom-mock、PostgreSQL）；controller 在 `agentgateway` |
| 数据面入口 | NodePort `30080` → 宿主机 `http://127.0.0.1:14001` |
| loom 端口 | `9001` extAuth HTTP、`9002` extAuth gRPC、`9100` 管理 API、`9101` OTLP ingest、`9102` `/metrics` |
| 宿主机工具 | `/opt/agentgateway/k8s/bin/{kind,kubectl,helm}`、`docker`；无 go |
| 部署目录 | 宿主机 `/opt/agentgateway/loom/{build,k8s,configs}` |
| 本机入口 | `apps/loom`，`deploy/deploy.sh` 一键交叉编译 + 部署，`deploy/smoke.sh` 执行验收矩阵 |

### 1.2 版本与制品基线

| 键 | 值 |
| --- | --- |
| Go | `1.25`（本机交叉编译 `linux/amd64`，`CGO_ENABLED=0`） |
| agentgateway | `v1.7.0`（`cr.agentgateway.dev/agentgateway:v1.7.0`） |
| loom 镜像 | `loom/loom:<tag>`，`FROM busybox:stable`，`kind load docker-image` 注入 |
| 依赖 | `gin v1.12.0`、`pgx/v5 v5.13.0`、`goose/v3 v3.30.1`、`sqlc v1.31.1`、`client_golang v1.25.0`、`golang-lru/v2 v2.0.7`、`koanf/v2 v2.4.1`、`grpc v1.85.0` |
| 数据库 | PostgreSQL 15（`postgres:15-alpine`，PVC `loom-postgres`） |

构建产物在 `apps/loom/build/`（不入库），部署脚本在远端 `docker build` 后 `kind load`。

### 1.3 架构与请求路径

```txt
调用方 ──Authorization/x-api-key + JSON body──► Gateway loom-gateway
   │  extAuth(forwardBody) ──► loom :9001 /check（或 :9002 ext_authz）
   │                              ① sha256 查 Key ② 状态 ③ 请求体 model 定价 ④ 白名单 ⑤ 两级额度原子预扣
   │                              ⑥ 放行：注入 x-loom-client-id / key-id / request-id / quota-remaining / model
   │  headerModifiers 删除 authorization / x-api-key
   ▼
AgentgatewayBackend(protocol=llm) → loom-mock ── usage ──► access log(OTLP/gRPC) ──► loom :9101
                                                              按 loom 计价表算钱 → usage_events + 结算预扣
:9102 /metrics ──► Prometheus
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

### 2.3 部署后检查

```bash
ssh 192.168.16.62 'export PATH=/opt/agentgateway/k8s/bin:$PATH; kubectl -n loom get pods,agentgatewaypolicy'
```

**通过标准：** `loom` 2/2、`loom-gateway` 1/1、`loom-mock` 1/1、`loom-postgres` 1/1 Running，`RESTARTS` 为 0；9 条 `AgentgatewayPolicy` 均 `ACCEPTED=True ATTACHED=True`。

### 2.4 离线目录说明

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

矩阵共 70 项检查，覆盖：鉴权拒绝矩阵、按量计费与预扣、分组倍率、按次计费、PG 兜底定价、embeddings、并发预扣、凭据头清理、gRPC 门面、管理 API 与指标、ConfigMap 热加载、FailClosed。脚本开头会通过管理 API 复位 `alice`、`erin` 的额度，可重复执行。

**通过标准：** 末行输出 `RESULT: PASS=70 FAIL=0`。

### 3.2 关键结果实测

| 检查项 | 结果 |
| --- | --- |
| 无凭据 / 未知 Key / 过期 Key | ✅，`401` `missing_credential` / `unknown_api_key` / `expired_api_key` |
| 停用账户 / 模型未定价 / 不在白名单 | ✅，`403` `client_inactive` / `model_not_priced` / `model_not_allowed` |
| `alice` 额度 `$0.005`，预扣 `3,072,000` | ✅，两次 `200` 后第三次 `403 insufficient_quota`，`quota_used = 3,640,000`，`reserved = 0` |
| 金额一致性 | ✅，`usage_events.cost_nanos = gateway_cost_nanos = 1,820,000`（`in=1000 cached=200 out=500`） |
| `vera`（vip 0.9） | ✅，loom `1,638,000`；网关 `1,820,000`（catalog 无分组倍率，对账跳过） |
| 图片模型按次 `lab-image` | ✅，`40,000,000`；热加载改价后 `50,000,000` |
| 仅在 PG 表的 `lab-pg-only` | ✅，`200`，`pricing_source = pg`，`910,000` |
| `erin` 额度够 5 次，并发 20 次 | ✅，`200=5 403=15` |
| `/echo` 上游请求头 | ✅，无 `authorization` / `x-api-key`，有 `x-loom-client-id=dave` 与 `x-loom-request-id` |
| `/grpc` gRPC 门面 | ✅，与 HTTP 门面结论一致 |
| ConfigMap 热加载 | ✅，所有副本 ≤ 3min 生效，无需重启，`loom_pricing_reload_total` 增长 |
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

- **结算异步、有短窗口**：预扣在鉴权时发生，释放在 access log 入库后（`flush_interval 2s`）。**同一 Key 连续两次请求若间隔小于结算延迟，第二次可能因预扣未释放被拒**；`quota.reserve_tokens` 越大越明显。
- `extAuth.cache` 不能开启：命中缓存的请求不会预扣。
- 网关 `modelCatalog` 不表达分组倍率：非 `default` 分组的账户，loom 金额 ≠ 网关金额是设计内行为，`loom_cost_mismatch_total` 对这类账户跳过。
- 只按 token 计费的模型必须经 `AgentgatewayBackend(protocol=llm)` 转发才有 usage；普通 HTTP 透传的路由（如当前 `/v1/embeddings`）token 为 0、费用为 0。
- 遥测可丢，转发不可停：ingest 队列满即丢弃并计 `loom_ingest_dropped_total`；账单是遥测口径。
- 以 loom 计价表为准扣费（`billing.cost_source: loom`）；网关金额只做对账。

## 四、日常运维

### 4.1 查看状态和日志

```bash
kubectl -n loom get pods
kubectl -n loom logs deploy/loom --tail=100
kubectl -n loom port-forward svc/loom 9102:9102 && curl localhost:9102/metrics | grep ^loom_
```

**通过标准：** 日志中每条决策有 `request_id` / `key_id` / `reason` / `model`；`/metrics` 有 `loom_auth_decisions_total`、`loom_quota_remaining_nanos`、`loom_reservations_open`。

### 4.2 管理 API

```bash
kubectl -n loom port-forward svc/loom 9100:9100
T=loom-admin-token-change-me
H="Authorization: Bearer $T"
curl -s -H "$H" localhost:9100/v1/accounts | jq
curl -s -H "$H" localhost:9100/v1/usage/summary | jq
curl -s -X POST -H "$H" -H 'content-type: application/json' localhost:9100/v1/accounts \
  -d '{"name":"acme","tenant":"t1","group":"vip","quota_limit_nanos":50000000000}'
curl -s -X POST -H "$H" -H 'content-type: application/json' localhost:9100/v1/keys \
  -d '{"account_id":"<uuid>","name":"prod","quota_limit_nanos":10000000000,"model_allowlist":["lab-model"]}'
```

创建 Key 的响应里 `plaintext` 只出现一次。`POST /v1/accounts/:id/topup` 增加额度上限；`POST /v1/accounts/:id/quota` 与 `POST /v1/keys/:id/quota` 直接设置上限/已用量并清空预扣（验收复位用）。

### 4.3 修改价格

ConfigMap 为主、PG 表兜底，两条路径都不需要重启：

```bash
kubectl -n loom create configmap loom-pricing --from-file=pricing.yaml=apps/loom/configs/pricing.yaml --dry-run=client -o yaml | kubectl apply -f -
curl -X PUT -H "$H" -H 'content-type: application/json' localhost:9100/v1/pricing/<model> -d '{"model_ratio":0.3,"completion_ratio":2,"cache_ratio":0.1}'
```

修改前先备份：`kubectl -n loom get configmap loom-pricing -o yaml > pricing.bak.yaml`。生效需 kubelet 同步 ConfigMap 卷（≤ 1 min）+ `pricing.reload_interval`（30s）。

**回滚路径：** `kubectl apply -f pricing.bak.yaml`；PG 行用 `DELETE /v1/pricing/<model>`。

### 4.4 停止服务

```bash
kubectl -n loom scale deploy/loom --replicas=0
```

`failureMode: FailClosed` 下所有受保护路由会拒绝；恢复 `--replicas=2` 后自动放行。完全卸载：`kubectl delete ns loom`（PostgreSQL PVC 一并删除）。

## 五、FAQ

- 现象：所有请求 `401 missing_credential`。先查策略 `allowedRequestHeaders` 是否包含 `authorization` / `x-api-key`；常见原因是只配了 `path` 没配转发头。
- 现象：请求体里的 `model` 定价总是 `model_not_priced`。先查策略是否有 `forwardBody.maxSize`；没有它 loom 看不到请求体，`x-loom-model` 头也为空。
- 现象：`GET /echo` 返回 `405`。loom 的 `/check` 不限方法；若自建鉴权服务只注册 `POST /check`，网关对 GET 请求会以 GET 发起校验并被原样透传 `405`。
- 现象：同一 Key 连续请求第二次就 `403 insufficient_quota`，额度明明够。先查上一次的预扣是否已结算（`loom_reservations_open`、`reservations` 表）；常见原因是结算延迟未到就发了下一次，或 access log 没送到 `:9101`（看 `loom_usage_events_ingested_total`）。
- 现象：loom 金额与网关 `agw.ai.usage.cost.total` 不一致。先查账户分组倍率是否为 `1`；`vip` 等分组下网关 catalog 不表达倍率，属设计内；再查 ConfigMap 与 `loom-catalog` 是否同源（`make catalog` 重新渲染）。
- 现象：Controller 报 Gateway `Programmed=False` 或 Deployment 冲突。Gateway 不能命名为 `loom`：controller 会以 Gateway 名创建同名 Deployment，与服务 Deployment 冲突；本环境用 `loom-gateway`。
- 现象：某模型只改了 PG `model_pricing` 表但价格没变。先查 `GET /v1/pricing` 的 `pg` 段；PG 兜底有 `pricing_ttl`（30s）正缓存，管理 API 写入会主动清缓存，直接改库需等缓存过期。
