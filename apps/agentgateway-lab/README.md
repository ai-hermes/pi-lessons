# agentgateway lab: BYO extAuth + telemetry billing

两个功能在本目录里是可运行、可复现的，而不是只写设计：

| Feature | 结论 | 证据 |
| --- | --- | --- |
| #2 BYO 外部鉴权 | `extAuth` 同时支持 **HTTP**（`extAuth.http`，200=允许）和 **gRPC**（`extAuth.grpc`，Envoy `ext_authz` v3），可挂 Gateway / Route / Backend，`failureMode: FailClosed` 生效 | 6 个用例全部按预期返回（见 “验证矩阵”），`auth_audit` 表逐条落库 |
| #3 审计 / 计费 | access log（OTLP/gRPC）→ `usage_events`；trace（OTLP/gRPC）→ `traces`；Prometheus `/metrics` 带 `gen_ai.*` + `client_id` 标签；每个请求的 realized cost 由网关按 model catalog 算出（`agw.ai.usage.cost.total`） | `/v1/usage/summary`、`/v1/traces/summary`、`:15020/metrics` |

## 数据流

```
client ──x-api-key──► agentgateway ──► extauth (HTTP :9001 / gRPC :9002)
                        │                    │  identity + budget
                        │                    └─► postgres: clients / sessions / auth_audit
                        ├──► echo backend（普通 HTTP）
                        └──► lab-llm（AgentgatewayBackend，伪 OpenAI）
                                 │ usage + agw.ai.usage.cost.total
                                 ▼
                     frontend.accessLog.otlp (GRPC :9101) ──► finops ──► usage_events
                     frontend.tracing.otlp   (GRPC :9101) ──► finops ──► traces
                     :15020/metrics ──► Prometheus / Grafana
```

agents 的 key 不落在网关 Secret 里：网关只做转发，凭证在 `extauth` 侧查 PostgreSQL，预算 / 停用 / session / JWT 都能即时生效（无需重新下发 Secret、无需重启网关）。

## 目录

```
cmd/echo        回声服务 + 伪 OpenAI /v1/chat/completions（带 usage / cached_tokens）
cmd/extauth     鉴权服务：HTTP /check + Envoy gRPC ext_authz + /admin/*
cmd/finops      计费服务：OTLP logs/metrics/traces 三个 ingest + chargeback API
internal/extauth  Decision 引擎（API key / session / JWT / 预算）、PG store、审计
internal/billing  token→cost（integer micro-USD）、OTLP 解析、attribution、trace 审计
deploy/k8s/     全部清单，按文件名顺序 apply
```

## 部署（kind 集群，离线件已就位）

服务器 `<lab-host-ip>:<lab-workdir>/k8s` 已有 `bin/{kind,kubectl,helm}`、`charts/`、`images/`。

```bash
export PATH=<lab-workdir>/k8s/bin:$PATH
kind get clusters                     # agentgateway
# 镜像：本目录交叉编译后放进 <lab-workdir>/lab/bin，逐个构建并注入 kind
cd <lab-workdir>/lab
for b in echo extauth finops; do
  docker build --build-arg BIN=$b -t agentgateway-lab/$b:v0.1.0 .
  kind load docker-image agentgateway-lab/$b:v0.1.0 --name agentgateway
done
kind load docker-image postgres:15-alpine --name agentgateway   # 离线节点拉不到 docker.io

for f in <lab-workdir>/k8s/config/lab/*.yaml; do kubectl apply -f "$f"; done
kubectl -n agentgateway-demo get pods,agentgatewaypolicy
```

端口：`hostPort 14001 → NodePort 30080`（`AgentgatewayParameters.spec.service.spec` 里声明），
`curl http://127.0.0.1:14001/...` 即打到数据面。

## 本地构建 / 单测

```bash
go vet ./... && go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w' -o bin/<svc> ./cmd/<svc>
```

## 验证矩阵（实际输出）

```bash
BASE=http://127.0.0.1:14001
curl -s -o /dev/null -w '%{http_code}\n' $BASE/echo                                    # 401 missing_credential
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-api-key: sk-lab-alice' $BASE/echo       # 200
curl -s -H 'x-api-key: sk-lab-bob'   $BASE/echo                                        # 429 budget_exhausted
curl -s -H 'x-api-key: sk-lab-carol' $BASE/echo                                        # 403 client_inactive
curl -s -H 'x-api-key: sk-bogus'     $BASE/echo                                        # 401 unknown_api_key
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $JWT" $BASE/echo     # 200（JWT）
curl -s -o /dev/null -w '%{http_code}\n' -H "x-session-token: $SESS" $BASE/echo        # 200（session）
```

| 用例 | 结果 |
| --- | --- |
| 无凭证 | `401 {"reason":"missing_credential"}` |
| `sk-lab-alice` | `200`，后端收到 `X-Client-Id/X-Tenant-Id/X-Plan/X-Auth-Source/X-Budget-Remaining-Cents` |
| `sk-lab-bob` | `429 budget_exhausted`（`spent_micros` 超 `budget_cents`） |
| `sk-lab-carol` | `403 client_inactive`（`status='disabled'`） |
| `sk-bogus` | `401 unknown_api_key` |
| JWT（HS256，`/admin/jwt` 签发） | `200`，过期 → `401 jwt_expired` |
| session（`/admin/session` 签发） | `200` |
| gRPC `ext_authz`（Route `/grpc`，`extAuth.grpc`） | `200` / `401 unknown_api_key` |
| 把 extauth 副本缩到 0 | `403 authorization failed`（FailClosed），恢复后 `200` |

计费侧：

```bash
kubectl -n agentgateway-demo exec deploy/lab-postgres -- psql -U agw -d agw_lab \
  -c "select client_id, model, input_tokens, output_tokens, cached_tokens, realized_cost_micros from usage_events order by time desc limit 5;"
kubectl -n agentgateway-demo exec deploy/finops -- wget -qO- http://127.0.0.1:9100/v1/usage/summary
kubectl -n agentgateway-demo exec deploy/finops -- wget -qO- http://127.0.0.1:9100/v1/traces/summary
```

一致性问题（重要）：网关访问日志里同时有 token 和 `agw.ai.usage.cost.total`，
lab 的 `usage_events.realized_cost_micros` 就等于网关算出来的值（例如 in=46 / cached=46 / out=128 →
`46*1 + 128*12 = 1582` micro-USD，与日志 `0.001582` 完全一致）。所以 chargeback 与网关自身指标不会漂移。

## 踩过的坑

1. **`allowedRequestHeaders` 必须显式列出凭证头**。不写 `authorization` / `x-api-key` / `x-session-token` 时，鉴权服务永远看到“没有凭证”。
2. **extAuth 之后就没有 `apiKey.client_id` 了**。限流 key 要改成 `request.headers["x-client-id"]`，或直接由 extAuth 返回的 metadata 决定。
3. **kind 节点拉不到 docker.io**：`postgres:15-alpine` 必须 `kind load docker-image`。
4. **`AgentgatewayParameters.image.repository` 是完整 repo 路径**，写 `agentgateway/agentgateway` 会导致 `<registry>/agentgateway/agentgateway:v1.7.0` 拉不到；本文用 `repository: agentgateway`。
5. **`modelCatalog` 只在 Gateway 级 parameters 里生效**，且 Gateway 要 `spec.infrastructure.parametersRef` 指过去，否则 realized cost 恒为 0。
6. **cost 单位**：catalog 的 `rates` 是「USD / 1M tokens」的字符串；库里用 integer micro-USD 存，避免浮点累计误差。
7. **OTLP 属性名以网关为准**：缓存命中是 `gen_ai.usage.cache_read.input_tokens`（带点），不是下划线形式；两种都做了兼容。

## 对外域名

| 域名 | 落点 | 配置 |
| --- | --- | --- |
| `<prod-ingress-domain>` | 生产 `ark-gateway` | nginx `conf.d/agentgateway-aii.conf`（已有） |
| `<lab-ingress-domain>` | 本 lab（16.62 kind） | nginx `conf.d/st2-aii.conf`（本目录 `deploy/nginx/`） |

数据面：nginx → `<lab-host-ip>:14001` → kind `NodePort 30080`。
UI / `config_dump`：nginx → `<lab-host-ip>:14003` → 宿主机 systemd
`agentgateway-lab-ui-port-forward.service`（`kubectl port-forward deploy/agentgateway-demo 14003:15000`）。
kind 的 `extraPortMappings` 只映射了 30080，所以 UI 不走 NodePort，改由 port-forward 暴露。

nginx 主机（`<nginx-host>`，<nginx-host-ip>）发布：

```bash
scp deploy/nginx/st2-aii.conf jump-user@<nginx-host>:/tmp/st2-aii.conf
sudo install -m 644 /tmp/st2-aii.conf /etc/nginx/conf.d/st2-aii.conf
sudo nginx -t && sudo systemctl reload nginx
```

验证（公网域名，已实测）：

```bash
H=<lab-ingress-domain>
curl -s -o /dev/null -w '%{http_code}\n' http://$H/ui/                                  # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-api-key: sk-lab-alice' http://$H/echo    # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-api-key: sk-lab-bob'   http://$H/echo    # 429
curl -s -o /dev/null -w '%{http_code}\n' http://$H/config_dump                          # 200
```

## 清理

```bash
kubectl delete ns agentgateway-demo
kind delete cluster --name agentgateway
```
