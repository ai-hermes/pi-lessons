# AgentGateway 外挂 Auth（extAuth）部署与使用手册

## 一、概览

本页覆盖 AgentGateway 外挂鉴权能力（`extAuth`）在 `st2-aii` kind 集群中的部署、验证与日常运维。核心结论：`extAuth` 支持 HTTP 与 Envoy gRPC `ext_authz` 两种协议，可挂在 Gateway / Route / Backend 三级；凭据不必落进网关 Secret，预算、停用、session、JWT 的变化都能即时反映到鉴权结果。**该能力只做放行/拒绝决策，看不到响应里的 token 用量，不能当计费点**；计费与遥测部分参考《AgentGateway 遥测审计计费部署与使用手册》。

### 1.1 部署环境与访问入口

| 键 | 值 |
| --- | --- |
| 集群 | `st2-aii`（kind） |
| 命名空间 | `agentgateway-demo` |
| 网关入口 | `:8080`（NodePort `30080`） |
| 公网入口 | `<lab-ingress-domain>`（经 nginx 转发） |
| extAuth HTTP | `extauth:9001`（`POST /check`） |
| extAuth gRPC | `extauth:9002`（Envoy `ext_authz` v3） |
| 鉴权管理面 | `:9001` 下 `/admin/clients`、`/admin/jwt`、`/admin/session` |

### 1.2 版本与制品基线

| 键 | 值 |
| --- | --- |
| agentgateway | `v1.7.0`（`cr.agentgateway.dev/agentgateway:agentgateway`） |
| extAuth 服务镜像 | `agentgateway-lab/extauth:v0.1.0` |
| 后端镜像 | `agentgateway-lab/echo:v0.1.0` |
| 部署清单 | `apps/agentgateway-lab/deploy/k8s/00-platform` … `08-tracing`，按文件名顺序 apply |
| 冒烟脚本 | `apps/agentgateway-lab/deploy/smoke.sh`（15 项检查） |

部署物料与安装手册见 [deploy-docs → extauth](https://github.com/ai-hermes/pi-lessons/tree/feat/agentgateway-extauth-finops/apps/agentgateway-lab/deploy/k8s)。

### 1.3 架构与请求路径

```txt
调用方 ──x-api-key──► AgentGateway ──► extAuth（HTTP :9001 / gRPC :9002）
                          │                 │ 决策 + identity 注入
                          │                 └─► PostgreSQL：clients / sessions / auth_audit
                          ├─► 普通 HTTP 后端（/echo）
                          └─► LLM（AgentgatewayBackend，protocol=llm）
```

一次请求的鉴权链路：

1. 调用方携带 `x-api-key`（或 `Authorization: Bearer`、`x-session-token`）请求网关。
2. 网关按 `AgentgatewayPolicy.spec.traffic.extAuth` 调用鉴权服务，把 `allowedRequestHeaders` 列出的头透传过去。
3. 鉴权服务按 `凭据提取 → 查找 → 状态检查 → 预算检查` 得出决策；放行时把 identity header 注入响应，由网关复制到上游请求。
4. 拒绝时自定义状态码（`401` / `403` / `429`）与响应体原样回给调用方。

设计思路：鉴权与计费是**两条独立链路**。鉴权失败就不该产生 token；产生了 token 的请求由遥测链路负责算钱，两者不互相依赖。

### 1.4 能力边界

| 能力 | 结论 | 边界 |
| --- | --- | --- |
| 外挂 Auth 服务 | HTTP + gRPC `ext_authz` 双协议；`FailClosed` 可选 | 只做放行/拒绝，看不到响应 token，**不能当计费点** |
| 决策即时性 | 预算、停用、session、JWT 每请求现查 | 依赖鉴权服务可用性，需多副本 + PDB |
| 与 `apiKeyAuthentication` 的关系 | 功能覆盖后者的本地哈希校验 | 二选一即可，不必叠加 |

`apiKeyAuthentication` 的字段只有 `configMapSelector / location / mode / secretRef / secretSelector`，没有远程查找能力——这就是需要外挂 Auth 的原因。

## 二、安装部署

> 前提：已获取 `feat/agentgateway-extauth-finops` 分支的代码并可在本机构建镜像。每完成一个步骤就执行对应检查，不要等所有命令执行完后再统一排错。

### 2.1 部署鉴权服务

`03-extauth.yaml` 以 Deployment + Service 方式启动 `extauth`，单进程同时监听 HTTP `:9001` 与 gRPC `:9002`（`EXTAUTH_MODE=both`）：

```bash
kubectl apply -f apps/agentgateway-lab/deploy/k8s/00-platform.yaml
kubectl apply -f apps/agentgateway-lab/deploy/k8s/01-lab-secrets.yaml
kubectl apply -f apps/agentgateway-lab/deploy/k8s/02-postgres.yaml
kubectl apply -f apps/agentgateway-lab/deploy/k8s/03-extauth.yaml
```

```bash
kubectl -n agentgateway-demo get deploy extauth
```

**通过标准：** `extauth` 副本 `READY 1/1`，`kubectl -n agentgateway-demo port-forward svc/extauth 9001` 后 `curl localhost:9001/healthz` 返回 `ok`。

如果副本起不来，先不要改镜像，优先检查：`01-lab-secrets.yaml` 里的 `extauth-dsn` 是否指向 `02-postgres.yaml` 创建的库。

### 2.2 给路由挂 HTTP extAuth

```yaml
apiVersion: agentgateway.dev/v1alpha1
kind: AgentgatewayPolicy
metadata:
  name: echo-ext-auth
  namespace: agentgateway-demo
spec:
  targetRefs:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: echo
  traffic:
    extAuth:
      backendRef:
        name: extauth
        port: 9001
      http:
        path: '"/check"'
        allowedRequestHeaders:
        - authorization
        - x-api-key
        - x-session-token
        - cookie
        - x-forwarded-for
        - x-request-id
        allowedResponseHeaders:
        - x-client-id
        - x-tenant-id
        - x-plan
        - x-auth-source
        - x-budget-remaining-cents
        - x-auth-denial-reason
      failureMode: FailClosed
```

HTTP 协议约定：鉴权服务返回 `2xx` 即放行，其他状态码原样回给客户端，响应体也透传，所以拒绝原因可以直接给到调用方。

```bash
kubectl apply -f apps/agentgateway-lab/deploy/k8s/05-policies.yaml
```

```bash
curl -s http://localhost:8080/echo -H 'x-api-key: anything'
```

**通过标准：** 返回 HTTP `401`，响应体含 `"reason":"missing_credential"` 或 `"unknown_api_key"`。

### 2.3 gRPC 协议（Envoy ext_authz v3）

已有 Envoy `ext_authz` 服务可以直接接过来，不用改协议：

```yaml
spec:
  targetRefs:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: grpc-echo
  traffic:
    extAuth:
      backendRef:
        name: extauth
        port: 9002
      grpc:
        contextExtensions:
          lab-tenant-tier: pro
      failureMode: FailClosed
```

`contextExtensions` 会作为 `context_extensions` 传给鉴权服务，适合传租户/环境这类静态上下文。

**通过标准：** gRPC 路由与 HTTP 路由对同一 key 给出一致的放行/拒绝结果。

### 2.4 决策引擎核心代码

鉴权决策收敛在一个函数里，HTTP 与 gRPC 两个门面共用，因此两个协议永远不会对同一请求给出不同结论：

```go
func (c *Config) Evaluate(store Store, req Request) Decision {
	decision := c.evaluate(store, req)
	if store != nil {
		store.Audit(AuditEvent{ /* client_id / source / allowed / reason … */ })
	}
	return decision
}

func (c *Config) evaluate(store Store, req Request) Decision {
	_, raw := Credential(req.Headers)
	if raw == "" {
		return deny(401, ReasonMissingCredential, "none")
	}
	switch {
	case strings.HasPrefix(raw, "sess_"):
		// session：查 sessions 表，过期即 401 session_expired
	case looksLikeJWT(raw):
		// JWT：HS256 验签 + exp 校验，401 invalid_jwt / jwt_expired
	default:
		// API key：SHA-256 后查 clients 表，401 unknown_api_key
	}
	if client.Status != "" && client.Status != "active" {
		return withIdentity(deny(403, ReasonInactiveClient, source), client, source)
	}
	if client.BudgetCents > 0 && client.SpentMicros >= client.BudgetCents*10000 {
		return withIdentity(deny(429, ReasonBudgetExhausted, source), client, source)
	}
	// 放行：注入 identity headers
}
```

三个设计点：

- **凭据永不落库明文**：`HashKey()` 用 SHA-256 存摘要，网关与鉴权服务都不保存原始 key。
- **拒绝也带身份**：`deny()` 返回的 `Decision` 附 `X-Auth-Denial-Reason` 响应头；预算耗尽/停用的拒绝还会带上 identity，便于调用方定位。
- **预算单位自洽**：`BudgetCents`（分）× `10000` 换算成 micro-USD 与 `SpentMicros` 比较，整数运算无浮点误差。

放行时注入的上游请求头：

| 注入 header | 用途 |
| --- | --- |
| `X-Client-Id` | 调用方身份，后续限流与计费的归属 |
| `X-Tenant-Id` | 租户归属 |
| `X-Plan` | 套餐（决定可用模型/额度） |
| `X-Auth-Source` | `api_key` / `jwt` / `session`，审计用 |
| `X-Budget-Remaining-Cents` | 剩余预算，业务侧可做软降级 |
| `X-Auth-Denial-Reason` | 仅响应头，拒绝原因 |

## 三、使用验证

### 3.1 鉴权矩阵

预期结果如下表，与 `deploy/smoke.sh` 的 15 项检查一致：

```bash
bash apps/agentgateway-lab/deploy/smoke.sh
```

| 用例 | 预期 | 说明 |
| --- | --- | --- |
| 无凭证访问 `/echo` | `401` | `missing_credential` |
| 有效 key（alice） | `200` | 后端收到 identity header |
| 预算耗尽的 key（bob） | `429` | `budget_exhausted` |
| 已停用的 key（carol） | `403` | `client_inactive` |
| 未知 key | `401` | `unknown_api_key` |
| JWT（HS256）/ session token | `200` | 过期 JWT → `401 jwt_expired` |
| gRPC `ext_authz` 路由 | `200` / `401` | 与 HTTP 协议结果一致 |
| 鉴权服务副本缩到 0 | `403` | `FailClosed` 生效，恢复后 `200` |

**通过标准：** 上表全部用例的实际状态码与拒绝原因逐项一致。

### 3.2 FailClosed 行为

```bash
kubectl -n agentgateway-demo scale deploy extauth --replicas=0
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/echo -H 'x-api-key: <alice-key>'
kubectl -n agentgateway-demo scale deploy extauth --replicas=1
```

**通过标准：** 副本为 0 时请求被拒（`403`），副本恢复后同一 key 返回 `200`。

### 3.3 公网链路

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<lab-ingress-domain>/echo -H 'x-api-key: <alice-key>'
```

**通过标准：** `/echo` 对同一 key 依次复现 `401` / `200` / `429` / `403`，`/ui/` 返回 `200`。

### 3.4 当前边界与风险

- **`allowedRequestHeaders` 是最大的坑**：必须显式列出 `authorization` / `x-api-key` / `x-session-token`。不写的话鉴权服务永远看到"没有凭证"，表现为 100% `missing_credential`，而且不报错。
- 每个请求多一次 RPC（同集群内通常 1–2ms），鉴权服务要设多副本 + PDB。
- 建议 `FailClosed`：鉴权服务不可用时宁可拒绝，也不要放过未鉴权流量。
- extAuth 之后请求里不再有 `apiKey.client_id`，`rateLimit.local.key` 应改成 `request.headers["x-client-id"]`，否则所有人的桶都为空值、共用一个。
- 用 `headerModifiers.request.remove` 把 `authorization` / `x-api-key` 从上游请求删掉，别让调用方凭证继续流向模型供应商。
- `rateLimit.local` 是每副本进程内令牌桶，不聚合；要精确需要外部令牌桶。

## 四、日常运维

### 4.1 查看鉴权状态

```bash
kubectl -n agentgateway-demo logs deploy/extauth --tail=50
```

**通过标准：** 能看到每条决策的 `client_id` / `allowed` / `reason`，无 panic。

### 4.2 客户端生命周期（增改、停用、预算）

```bash
curl -X POST http://localhost:9001/admin/clients -H 'X-Admin-Token: <token>' \
  -d '{"client_id":"dave","api_key":"<new-key>","budget_cents":100,"status":"active"}'
curl -X POST http://localhost:9001/admin/clients -H 'X-Admin-Token: <token>' \
  -d '{"client_id":"dave","api_key":"<new-key>","status":"inactive"}'
```

**通过标准：** 停用后该 key 下一次请求立即返回 `403 client_inactive`；预算写小后耗尽的 key 返回 `429 budget_exhausted`。

### 4.3 修改鉴权服务配置

修改前先备份清单（`kubectl get deploy extauth -o yaml > extauth.bak.yaml`）；`EXTAUTH_JWT_SECRET` 轮转会使已签发 JWT 全部失效，需在低峰执行。改完先 `kubectl apply --dry-run=client` 校验再 apply。

**回滚路径：** `kubectl apply -f extauth.bak.yaml`。

## 五、FAQ

- 现象：所有请求都 `401 missing_credential`。先查 `allowedRequestHeaders` 是否包含 `authorization` / `x-api-key` / `x-session-token`；常见原因是清单只配了 `path` 没配转发头。
- 现象：鉴权服务挂了但请求仍被放行。先查 `failureMode` 是否为 `FailClosed`；常见原因是默认 `FailOpen` 或策略没挂到正确的 targetRef。
- 现象：所有人共用一个限流桶。先查 `rateLimit.local.key` 是否仍取 `apiKey.client_id`；常见原因是 extAuth 模式下该值恒为空。
- 现象：模型供应商收到了调用方的原始 key。先查 `headerModifiers.request.remove` 是否删除 `authorization` / `x-api-key`；常见原因是漏配。
- 现象：HTTP 与 gRPC 协议结果不一致。先查两个门面是否共用同一 `Store`；常见原因是各自独立部署、数据不同步。
