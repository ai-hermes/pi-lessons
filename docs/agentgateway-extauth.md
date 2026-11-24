# AgentGateway 外挂 Auth（extAuth）部署与使用手册

## 一、概览

本页讲清楚 AgentGateway 外挂鉴权能力（`extAuth`）在 `st2-aii` kind 集群中**如何工作**（二、三、四章：链路、spec、单引擎实现、双协议门面）与**如何安装验证**（五、六、七章）。核心结论：`extAuth` 支持 HTTP 与 Envoy gRPC `ext_authz` 两种协议，可挂在 Gateway / Route / Backend 三级；凭据不必落进网关 Secret，预算、停用、session、JWT 的变化都能即时反映到鉴权结果。**该能力只做放行/拒绝决策，看不到响应里的 token 用量，不能当计费点**；计费与遥测部分参考 <mention url="https://app.notion.com/p/42225bd1f1778158a80cd6fc1e4736bc">AgentGateway 遥测审计计费部署与使用手册</mention>。

### 1.1 版本与制品基线

| 键 | 值 |
| --- | --- |
| 集群 | `st2-aii`（kind），命名空间 `agentgateway-demo` |
| agentgateway | `v1.7.0`（`cr.agentgateway.dev/agentgateway:agentgateway`） |
| extAuth 服务镜像 | `agentgateway-lab/extauth:v0.1.0`，单进程同时监听 HTTP `:9001` / gRPC `:9002`（`EXTAUTH_MODE=both`） |
| 决策存储 | PostgreSQL：`clients` / `sessions` / `auth_audit` |
| 部署清单 | `apps/agentgateway-lab/deploy/k8s/00-platform` … `08-tracing`，按文件名顺序 apply |
| 冒烟脚本 | `apps/agentgateway-lab/deploy/smoke.sh`（15 项检查） |

部署物料与安装手册见 [deploy-docs → extauth](https://github.com/ai-hermes/pi-lessons/tree/feat/agentgateway-extauth-finops/apps/agentgateway-lab/deploy/k8s)。

### 1.2 链路总图

```txt
调用方 ──x-api-key──► AgentGateway ──► extAuth（HTTP :9001 / gRPC :9002）
                          │                 │ 决策 + identity 注入
                          │                 └─► PostgreSQL：clients / sessions / auth_audit
                          ├─► 普通 HTTP 后端（/echo）
                          └─► LLM（AgentgatewayBackend，protocol=llm）
```

设计要点：鉴权与计费是**两条独立链路**。鉴权失败就不该产生 token；产生了 token 的请求由遥测链路负责算钱，两者不互相依赖。

## 二、鉴权链路与 spec

### 2.1 一次请求的五步链路

```txt
调用方 ──x-api-key──► Gateway
                        │ ① 按 spec.traffic.extAuth 调鉴权服务
                        │ ② 只透传 allowedRequestHeaders 列出的头
                        ▼
                   extAuth 服务（HTTP :9001 / gRPC :9002）
                        │ ③ Evaluate()：凭据提取 → 查找 → 状态 → 预算
                        │ ④ 放行：2xx / OK + identity headers
                        │ ⑤ 拒绝：4xx / Denied + 状态码与原因透传
                        ▼
                   上游后端（收到注入的 X-Client-Id 等头）
```

### 2.2 对照 YAML 逐步讲解

每步先给清单片段，紧跟要点解释（Notion 版为左 YAML / 右解释两栏对照，本页为顺序版）；①②④⑤ 各一段 YAML，③ 在引擎里、无清单（见三章）。

**第①步 挂载策略**。`targetRefs` 决定挂在哪一级（HTTPRoute / Gateway / Backend），`backendRef` 指向鉴权服务：

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
        port: 9001        # HTTP 门面；gRPC 门面用 9002
```

- `targetRefs` 挂到 `/echo` 这条 HTTPRoute，策略只作用于该路由；挂 Gateway 级则整网关生效，挂 Backend 级只对该后端生效
- `backendRef` 指向 `extauth` 服务的 `9001` 端口（HTTP 门面）；gRPC 门面用 `9002`
- `spec.traffic.extAuth` 是整个外挂鉴权的入口字段

**第②步 头转发**。网关只把 `allowedRequestHeaders` 列出的头透传给鉴权服务，其余一律不给：

```yaml
      http:
        path: '"/check"'
        allowedRequestHeaders:
        - authorization
        - x-api-key
        - x-session-token
        - cookie
        - x-forwarded-for
        - x-request-id
```

- `path` 指向鉴权服务的检查端点，是 CEL 字符串、内层引号不能省
- 网关默认不转发凭证头，三个凭证头必须在此显式列出
- `cookie` / `x-forwarded-for` / `x-request-id` 用于审计与排错，可按需增删

<callout icon="⚠️" color="yellow_bg">
`allowedRequestHeaders` 是这个功能最大的坑：必须显式列出 `authorization` / `x-api-key` / `x-session-token`。不写的话鉴权服务永远看到"没有凭证"，表现为 100% `missing_credential`，而且不报错。
</callout>

**第③步 决策**。鉴权服务内部执行 `Evaluate()`，按「凭据提取 → 查找 → 状态 → 预算」得出结论；这一步与协议无关（见三章）。

**第④步 放行与注入**。放行时鉴权服务返回的响应头中，被 `allowedResponseHeaders` 列出的头由网关复制到上游请求：

```yaml
        allowedResponseHeaders:
        - x-client-id
        - x-tenant-id
        - x-plan
        - x-auth-source
        - x-budget-remaining-cents
        - x-auth-denial-reason
      failureMode: FailClosed
```

- 五个 identity header 注入上游请求：身份 / 租户 / 套餐 / 凭证来源 / 剩余预算，后续限流与计费都依赖它们
- `x-auth-denial-reason` 仅出现在拒绝时的响应头
- `failureMode: FailClosed`：鉴权服务不可用时宁可拒绝，不放未鉴权流量

| 注入 header | 用途 |
| --- | --- |
| `X-Client-Id` | 调用方身份，后续限流与计费的归属 |
| `X-Tenant-Id` | 租户归属 |
| `X-Plan` | 套餐（决定可用模型/额度） |
| `X-Auth-Source` | `api_key` / `jwt` / `session`，审计用 |
| `X-Budget-Remaining-Cents` | 剩余预算，业务侧可做软降级 |
| `X-Auth-Denial-Reason` | 仅响应头，拒绝原因 |

**第⑤步 拒绝透传**。拒绝时网关把鉴权服务的状态码（`401` / `403` / `429`）与响应体**原样**回给调用方，所以拒绝原因可以直接给到客户端；gRPC 门面用 `DeniedHttpResponse` 表达同样语义，`X-Auth-Denial-Reason` 仅出现在响应头。

### 2.3 spec 关键字段速查

| 字段 | 作用 | 备注 |
| --- | --- | --- |
| `backendRef.name/port` | 鉴权服务地址 | `9001` = HTTP，`9002` = gRPC |
| `http.path` | HTTP 门面的检查路径（CEL 字符串） | 实测 `'"`/check`"'` |
| `http.allowedRequestHeaders` | 透传给鉴权服务的请求头 | 不列凭证头 = 全部 `missing_credential` |
| `http.allowedResponseHeaders` | 从放行响应复制到上游的头 | identity header 注入的通道 |
| `grpc.contextExtensions` | 传给鉴权服务的静态键值上下文 | 适合租户/环境 |
| `failureMode` | 鉴权服务不可用时的行为 | 建议 `FailClosed` |

## 三、核心实现：一套决策引擎

核心逻辑只有一套，HTTP 与 gRPC 两个门面共用同一个 `Evaluate()`，因此两个协议永远不会对同一请求给出不同结论。

### 3.1 单引擎入口

```go
func (c *Config) Evaluate(store Store, req Request) Decision {
	decision := c.evaluate(store, req)
	if store != nil {
		store.Audit(AuditEvent{ /* client_id / source / allowed / reason … */ })
	}
	return decision
}
```

`evaluate()` 的主干是四段：凭据提取、凭据查找、状态与预算检查、构造决策。审计在入口统一发出，写入 `auth_audit` 表。

### 3.2 凭据提取

```go
func Credential(headers map[string]string) (kind, value string) {
	// Authorization: Bearer …  → "bearer"
	// x-api-key: …            → "api_key"
	// x-session-token: …      → "session"
}
```

三种凭证决定三条查找路径：

- `x-api-key` / `Authorization: Bearer`（非 JWT 形态）→ 按 SHA-256 摘要查 `clients` 表，未命中返回 `401 unknown_api_key`；
- 形如 `sess_` 的 token → 查 `sessions` 表，过期返回 `401 session_expired`；
- 两段点的 JWT → HS256 验签 + `exp` 校验，`401 invalid_jwt` / `401 jwt_expired`。

```go
func HashKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
```

**凭据永不落库明文**：网关与鉴权服务都只保存 SHA-256 摘要。

### 3.3 状态与预算检查

```go
if client.Status != "" && client.Status != "active" {
	return withIdentity(deny(403, ReasonInactiveClient, source), client, source)
}
if client.BudgetCents > 0 && client.SpentMicros >= client.BudgetCents*10000 {
	return withIdentity(deny(429, ReasonBudgetExhausted, source), client, source)
}
```

预算换算是整数运算：`BudgetCents`（分）× `10000` 换算成 micro-USD 与 `SpentMicros` 比较，无浮点误差。`deny()` 返回的决策附 `X-Auth-Denial-Reason` 响应头；预算耗尽/停用的拒绝还带上 identity，便于调用方定位。JWT 客户端不在配额表时，签发的合法 token 足以识别调用方（IdP 侧身份），默认按 active 处理。

### 3.4 审计

每次决策（无论放行与否）在 `Evaluate()` 入口写一条 `auth_audit`，字段为 `client_id / source / allowed / status / reason`，拒绝原因是稳定字符串（`missing_credential` 等），可直接用于看板，无需解析文本。

## 四、协议门面：HTTP 与 gRPC

### 4.1 对照表

| 维度 | HTTP（`:9001`） | gRPC（`:9002`） |
| --- | --- | --- |
| 协议契约 | 网关 `POST` 到 `http.path`，透传 `allowedRequestHeaders` | Envoy `ext_authz` v3 的 `CheckRequest`（结构化 `AttributeContext`） |
| 允许信号 | 鉴权服务返回 **2xx** | `CheckResponse` 返回 `OK` + `OkHttpResponse` |
| 拒绝信号 | 非 2xx 即拒绝，状态码与响应体**原样透传**给客户端 | `Denied` + `DeniedHttpResponse`（自定义 HTTP status / body / headers） |
| 静态上下文 | 靠请求头 | `grpc.contextExtensions` 键值对 |
| 典型场景 | 自研鉴权服务、复用现有 REST、`curl` 可调试 | 已有 Envoy 体系 `ext_authz` 服务，不改协议直接接入 |
| 开销 | 每请求一次 HTTP 调用 | HTTP/2 长连接 + protobuf，连接复用；同集群内两者都在 1–2ms |

### 4.2 HTTP 门面

```go
func (h *HTTPAuth) check(w http.ResponseWriter, r *http.Request) {
	dec := h.Engine.Evaluate(h.Store, reqFrom(r))
	if !dec.Allow {
		// 非 2xx：状态码 + {"reason": …} 原样回给客户端
		w.WriteHeader(dec.HTTPStatus)
		return
	}
	// 2xx：identity headers 写入响应头，由网关按 allowedResponseHeaders 复制
	for k, v := range dec.Headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(http.StatusOK)
}
```

HTTP 门面跑在 `:9001`，另有 `/admin/clients`、`/admin/jwt`、`/admin/session` 管理端点（见七章）。

### 4.3 gRPC 门面

```go
func (s *GRPCServer) Check(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	decision := s.engine.Evaluate(s.store, reqFromGRPC(req))
	if decision.Allow {
		return &authv3.CheckResponse{
			Status: &status.Status{Code: int32(codes.OK)},
			HttpResponse: &authv3.CheckResponse_OkResponse{
				OkResponse: &authv3.OkHttpResponse{Headers: headerOptions(decision.Headers)},
			},
		}, nil
	}
	return &authv3.CheckResponse{
		Status: &status.Status{Code: int32(codes.PermissionDenied), Message: decision.Reason},
		HttpResponse: &authv3.CheckResponse_DeniedResponse{
			DeniedResponse: &authv3.DeniedHttpResponse{
				Status:  &typev3.HttpStatus{Code: typev3.StatusCode(decision.HTTPStatus)},
				Headers: headerOptions(decision.Headers),
			},
		},
	}, nil
}
```

gRPC 门面同时注册了 gRPC health 与 reflection，方便探活与调试。`grpc.contextExtensions` 会作为 `context_extensions` 传给鉴权服务，适合传租户/环境这类静态上下文。

### 4.4 选型建议

新建鉴权服务选 HTTP（简单、可观测、调试成本最低）；存量 Envoy 体系或追求连接复用选 gRPC。两者切换只改 `extAuth` 下的 `http:` / `grpc:` 块和端口，业务侧无感。

## 五、安装部署

<callout icon="⚠️" color="yellow_bg">
前提：已获取 `feat/agentgateway-extauth-finops` 分支的代码并可在本机构建镜像。每完成一个步骤就执行对应检查，不要等所有命令执行完后再统一排错。
</callout>

### 5.1 部署鉴权服务

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

### 5.2 挂 HTTP extAuth（对应 4.2）

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

```bash
kubectl apply -f apps/agentgateway-lab/deploy/k8s/05-policies.yaml
curl -s http://localhost:8080/echo -H 'x-api-key: anything'
```

**通过标准：** 返回 HTTP `401`，响应体含 `"reason":"missing_credential"` 或 `"unknown_api_key"`。

### 5.3 挂 gRPC extAuth（对应 4.3）

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

**通过标准：** gRPC 路由与 HTTP 路由对同一 key 给出一致的放行/拒绝结果（`07-extauth-grpc.yaml`）。

## 六、使用验证

### 6.1 鉴权矩阵

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

### 6.2 FailClosed 行为

```bash
kubectl -n agentgateway-demo scale deploy extauth --replicas=0
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/echo -H 'x-api-key: <alice-key>'
kubectl -n agentgateway-demo scale deploy extauth --replicas=1
```

**通过标准：** 副本为 0 时请求被拒（`403`），副本恢复后同一 key 返回 `200`。

### 6.3 公网链路

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<lab-ingress-domain>/echo -H 'x-api-key: <alice-key>'
```

**通过标准：** `/echo` 对同一 key 依次复现 `401` / `200` / `429` / `403`，`/ui/` 返回 `200`。

### 6.4 当前边界与风险

- 每个请求多一次 RPC（同集群内通常 1–2ms），鉴权服务要设多副本 + PDB。
- 建议 `FailClosed`：鉴权服务不可用时宁可拒绝，也不要放过未鉴权流量。
- extAuth 之后请求里不再有 `apiKey.client_id`，`rateLimit.local.key` 应改成 `request.headers["x-client-id"]`，否则所有人的桶都为空值、共用一个。
- 用 `headerModifiers.request.remove` 把 `authorization` / `x-api-key` 从上游请求删掉，别让调用方凭证继续流向模型供应商。
- `rateLimit.local` 是每副本进程内令牌桶，不聚合；要精确需要外部令牌桶。

## 七、日常运维

### 7.1 查看鉴权状态

```bash
kubectl -n agentgateway-demo logs deploy/extauth --tail=50
```

**通过标准：** 能看到每条决策的 `client_id` / `allowed` / `reason`，无 panic。

### 7.2 客户端生命周期（增改、停用、预算）

```bash
curl -X POST http://localhost:9001/admin/clients -H 'X-Admin-Token: <token>' \
  -d '{"client_id":"dave","api_key":"<new-key>","budget_cents":100,"status":"active"}'
curl -X POST http://localhost:9001/admin/clients -H 'X-Admin-Token: <token>' \
  -d '{"client_id":"dave","api_key":"<new-key>","status":"inactive"}'
```

**通过标准：** 停用后该 key 下一次请求立即返回 `403 client_inactive`；预算写小后耗尽的 key 返回 `429 budget_exhausted`。

### 7.3 修改鉴权服务配置

修改前先备份清单（`kubectl get deploy extauth -o yaml > extauth.bak.yaml`）；`EXTAUTH_JWT_SECRET` 轮转会使已签发 JWT 全部失效，需在低峰执行。改完先 `kubectl apply --dry-run=client` 校验再 apply。

**回滚路径：** `kubectl apply -f extauth.bak.yaml`。

## 八、FAQ

- 现象：所有请求都 `401 missing_credential`。先查 `allowedRequestHeaders` 是否包含 `authorization` / `x-api-key` / `x-session-token`；常见原因是清单只配了 `path` 没配转发头。
- 现象：鉴权服务挂了但请求仍被放行。先查 `failureMode` 是否为 `FailClosed`；常见原因是默认 `FailOpen` 或策略没挂到正确的 targetRef。
- 现象：所有人共用一个限流桶。先查 `rateLimit.local.key` 是否仍取 `apiKey.client_id`；常见原因是 extAuth 模式下该值恒为空。
- 现象：模型供应商收到了调用方的原始 key。先查 `headerModifiers.request.remove` 是否删除 `authorization` / `x-api-key`；常见原因是漏配。
- 现象：HTTP 与 gRPC 协议结果不一致。先查两个门面是否共用同一 `Store`；常见原因是各自独立部署、数据不同步。
