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

### 2.2 完整策略 YAML

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

逐字段解释：

- `targetRefs`：挂到 `/echo` 这条 HTTPRoute；也可挂 Gateway / Backend 级
- `backendRef`：鉴权服务地址，`9001` = HTTP 门面，`9002` = gRPC 门面
- `http.path`：检查端点；CEL 字符串，内层引号不能省
- `allowedRequestHeaders`：网关默认不转发凭证头，不列 = 鉴权服务永远看不到凭证（100% `missing_credential` 且不报错）；`cookie` / `x-forwarded-for` / `x-request-id` 用于审计排错，可按需增删
- `allowedResponseHeaders`：采用白名单机制，仅放行响应中被列出的头复制到上游请求，把 auth 服务识别出的调用方身份随请求带给后端；`x-auth-denial-reason` 只在拒绝时出现，随拒绝响应回给调用方
- `failureMode: FailClosed`：鉴权服务不可用时宁可拒绝，不放未鉴权流量

**请求契约**：网关 `POST` `path`，只透传 `allowedRequestHeaders` 列出的头；鉴权服务返回 **2xx 即放行**，其他状态码与响应体原样回给调用方（`401` / `403` / `429` + 拒绝原因）。

**放行**：2xx 响应中被 `allowedResponseHeaders` 列出的头复制到上游请求——auth 服务识别出的调用方身份就是靠这一步随请求带给后端的，后续限流与计费都依赖 `X-Client-Id`。

**拒绝**：`X-Auth-Denial-Reason` 仅出现在拒绝响应头；gRPC 门面用 `DeniedHttpResponse` 表达同样语义。

**可用性**：`FailClosed` + 鉴权服务多副本 + PDB；每请求多一次 RPC，同集群内通常 1–2ms。

**调用方凭证处理**：放行后建议用 `headerModifiers.request.remove` 删掉 `authorization` / `x-api-key`，别让调用方凭证流向模型供应商。

### 2.3 extAuth 服务自身的资源（`backendRef` 背后）

策略里的 `backendRef: extauth` 指向下面这套 Deployment + Service（`deploy/k8s/03-extauth.yaml`）：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: extauth
  namespace: agentgateway-demo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: extauth
  template:
    metadata:
      labels:
        app: extauth
    spec:
      containers:
      - name: extauth
        image: agentgateway-lab/extauth:v0.1.0
        env:
        - name: EXTAUTH_MODE
          value: both
        - name: EXTAUTH_HTTP_ADDR
          value: :9001
        - name: EXTAUTH_GRPC_ADDR
          value: :9002
        - name: EXTAUTH_PG_DSN
          valueFrom:
            secretKeyRef:
              name: lab-secrets
              key: extauth-dsn
        - name: EXTAUTH_ADMIN_TOKEN
          valueFrom:
            secretKeyRef:
              name: lab-secrets
              key: admin-token
        - name: EXTAUTH_JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: lab-secrets
              key: jwt-secret
        readinessProbe:
          httpGet:
            path: /healthz
            port: 9001
        livenessProbe:
          httpGet:
            path: /healthz
            port: 9001
---
apiVersion: v1
kind: Service
metadata:
  name: extauth
  namespace: agentgateway-demo
spec:
  selector:
    app: extauth
  ports:
  - name: http
    port: 9001
    targetPort: 9001
  - name: grpc
    port: 9002
    targetPort: 9002
```

- **单进程双协议**：`EXTAUTH_MODE=both` 同时监听 `:9001`（`/check`、`/admin/*`、`/healthz`）与 `:9002`（Envoy `ext_authz` v3），一套决策引擎保证两个门面结果一致
- **敏感配置全走 Secret**：PG DSN、admin token、JWT secret 均来自 `lab-secrets`，不落明文
- **Service 两个端口与策略对应**：策略里 `port: 9001` 走 `http` 口、`port: 9002` 走 `grpc` 口
- **探针**：readiness / liveness 都打 `/healthz:9001`；配合 `FailClosed`，副本不可用时网关拒绝而不是放行
- **生产基线**：多副本 + PDB；资源请求 `100m`/`128Mi`、内存上限 `256Mi`
- 客户端 / 预算数据在 PostgreSQL（`clients` / `sessions` / `auth_audit`），由 `02-postgres.yaml` 提供

## 三、核心实现：一套决策引擎

核心逻辑只有一套，HTTP 与 gRPC 两个门面共用同一个 `Evaluate()`，因此两个协议永远不会对同一请求给出不同结论。整个决策就是下面这一段主干（精简自 `internal/extauth/decide.go`，凭证提取到构造决策一气呵成）：

```go
func (c *Config) evaluate(store Store, req Request) Decision {
	// 1. 凭据提取：Bearer / x-api-key / x-session-token
	_, raw := Credential(req.Headers)
	if raw == "" {
		return deny(401, ReasonMissingCredential, "none")
	}

	// 2. 按凭证形态走三条查找路径
	switch {
	case strings.HasPrefix(raw, "sess_"):
		// session：查 sessions 表，含过期时间
		cli, ok := store.LookupSession(HashKey(raw), c.now())
		if !ok { return deny(401, ReasonExpiredSession, "session") }
		client = cli
	case looksLikeJWT(raw):
		// JWT：HS256 验签 + exp 校验
		claims, err := c.verifyHS256(raw)
		if err == errJWTExpired {
			return deny(401, ReasonExpiredJWT, "jwt") }
		if err != nil {
			return deny(401, ReasonInvalidJWT, "jwt") }
		// IdP 签发的合法 token 足以识别调用方，
		// 不在配额表里按 active 处理
		client = lookupOrCreate(claims)
	default:
		// API key：SHA-256 摘要后查 clients 表
		cli, ok := store.LookupKey(HashKey(raw))
		if !ok { return deny(401, ReasonUnknownKey, "api_key") }
		client = cli
	}

	// 3. 状态与预算检查
	if client.Status != "" && client.Status != "active" {
		return deny(403, ReasonInactiveClient, source)
	}
	if client.BudgetCents > 0 &&
		client.SpentMicros >= client.BudgetCents*10000 {
		return deny(429, ReasonBudgetExhausted, source)
	}

	// 4. 放行：构造 identity headers
	return allow(identityOf(client, source))
}
```

- **三条查找路径对应三种拒绝码**：API key 未命中 → `401 unknown_api_key`；session 过期 → `401 session_expired`；JWT 验签失败/过期 → `401 invalid_jwt` / `401 jwt_expired`
- **凭据永不落明文**：`HashKey()` 先做 SHA-256，网关与鉴权服务都只存摘要
- **预算是整数运算**：`BudgetCents`（分）× `10000` 换算成 micro-USD 与 `SpentMicros` 比较，无浮点误差
- **拒绝时说明原因**：拒绝响应头带 `X-Auth-Denial-Reason`，值是固定枚举（`missing_credential`、`budget_exhausted` 等）；能定位到客户端的拒绝（预算耗尽、账号停用）还会带上身份头，调用方可以直接自查是哪个账号出了什么问题
- **审计在入口统一发出**：`Evaluate()` 每次决策写一条 `auth_audit`（client_id / source / allowed / status / reason），拒绝原因是稳定字符串，看板可直接消费；两个门面共用，结论一致

## 四、协议门面：HTTP 与 gRPC

第三章的 `Evaluate()` 是协议无关的，两个门面的差异只在「请求怎么递过来、决策怎么送回去」。下面把两种协议的请求处理并排对照，先 HTTP 后 gRPC。

**HTTP（`:9001`）——自研鉴权服务、复用现有 REST，`curl` 可直接调试**

```go
// 网关 POST /check，只透传 allowedRequestHeaders 列的头
func (h *HTTPAuth) check(w http.ResponseWriter, r *http.Request) {
	dec := h.Engine.Evaluate(h.Store, reqFrom(r))
	if !dec.Allow {
		// 非 2xx：状态码 + {"reason": …} 原样回给客户端
		w.WriteHeader(dec.HTTPStatus)
		return
	}
	// 2xx：identity headers 写入响应头，
	// 网关按 allowedResponseHeaders 复制到上游
	for k, v := range dec.Headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(http.StatusOK)
}
```

契约一句话：**2xx 即放行**；其他状态码与响应体原样透传，拒绝原因调用方直接可见。

**gRPC（`:9002`）——存量 Envoy `ext_authz` 服务，不改协议直接接入**

```go
// Envoy ext_authz v3 的 Check()
func (s *GRPCServer) Check(ctx context.Context,
	req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	decision := s.engine.Evaluate(s.store, reqFromGRPC(req))
	if decision.Allow {
		return &authv3.CheckResponse{
			Status: &status.Status{Code: int32(codes.OK)},
			HttpResponse: &authv3.CheckResponse_OkResponse{
				OkResponse: &authv3.OkHttpResponse{
					Headers: headerOptions(decision.Headers)}},
		}, nil
	}
	return &authv3.CheckResponse{
		Status: &status.Status{Code: int32(codes.PermissionDenied)},
		HttpResponse: &authv3.CheckResponse_DeniedResponse{
			DeniedResponse: &authv3.DeniedHttpResponse{
				Status:  &typev3.StatusCode(decision.HTTPStatus),
				Headers: headerOptions(decision.Headers)}},
	}, nil
}
```

契约一句话：**`OK` 即放行**，要注入的头放在 `OkHttpResponse` 里随请求带下去；拒绝时返回 `Denied`，回给客户端的状态码、body 和响应头都可以在 `DeniedHttpResponse` 里指定。租户、环境这类不随请求变化的上下文，用 `grpc.contextExtensions` 传给鉴权服务。gRPC 门面同时注册了 health 与 reflection，方便探活与调试；HTTP 门面另挂 `/admin/clients`、`/admin/jwt`、`/admin/session` 管理端点（见七章）。

两个门面跑在同一个 `extauth` 进程里（`:9001` + `:9002`，`EXTAUTH_MODE=both`），共用同一引擎与存储，所以对同一 key 的结果必然一致。选型上新服务选 HTTP（简单、可观测、调试成本低），存量 Envoy 体系选 gRPC（HTTP/2 长连接复用、契约强类型）；开销同量级，同集群内都在 1–2ms；切换只改 `extAuth` 下的 `http:` / `grpc:` 块和端口，业务侧无感。

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
