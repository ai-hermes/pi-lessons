# AgentGateway 遥测审计计费部署与使用手册

## 一、概览

本页覆盖 AgentGateway 审计与计费能力在 `st2-aii` kind 集群中的部署、验证与日常运维。核心结论：**审计与计费主要通过遥测对接**——access log / trace 走 OTLP 直发计费服务，网关对 `protocol=llm` 请求直接输出 `gen_ai.usage.*` 与 `agw.ai.usage.cost.total`，计费侧不需要旁路复制响应体，接受遥测链路 best-effort。外挂鉴权部分参考《AgentGateway 外挂 Auth（extAuth）部署与使用手册》。

### 1.1 部署环境与访问入口

| 键 | 值 |
| --- | --- |
| 集群 | `st2-aii`（kind） |
| 命名空间 | `agentgateway-demo` |
| finops HTTP API | `finops:9100`（`/v1/usage/summary` 等） |
| finops OTLP/gRPC | `finops:9101`（Logs / Metrics / Traces 三合一） |
| 网关 metrics | `:15020/metrics`（`15000` 是 UI/admin 端口，metrics 只在 `15020`） |
| 存储 | PostgreSQL：`usage_events` / `traces` / `auth_audit` / `price_catalog` |

### 1.2 版本与制品基线

| 键 | 值 |
| --- | --- |
| agentgateway | `v1.7.0` |
| finops 服务镜像 | `agentgateway-lab/finops:v0.1.0` |
| 价格目录 | ConfigMap `lab-model-catalog`（`catalog.json`） |
| 示例模型 | `lab-model`：input `3` / output `12` / cacheRead `1`（USD / 1M tokens，字符串） |

部署物料与安装手册见 [deploy-docs → finops](https://github.com/ai-hermes/pi-lessons/tree/feat/agentgateway-extauth-finops/apps/agentgateway-lab/deploy/k8s)。

### 1.3 架构与请求路径

```txt
调用方 ──x-api-key──► AgentGateway ──► LLM（AgentgatewayBackend，protocol=llm）
                          │                │ usage + realized cost
                          ▼
          access log (OTLP) ─► finops :9101 ─► usage_events（计费）
          traces     (OTLP) ─► finops :9101 ─► traces（争议取证）
          :15020/metrics    ─► Prometheus / Grafana
```

设计思路：鉴权与计费是**两条独立链路**。鉴权失败就不该产生 token；产生了 token 的请求由遥测链路负责算钱，两者不互相依赖。计费主路径是 access log，trace 只做争议取证，不参与金额计算。

一次请求的计费链路：

1. 网关转发 LLM 请求，从响应 usage 读出 token 数，按价格目录算出 realized cost。
2. access log 以 OTLP/gRPC 推给 `finops:9101`，属性里带 token / cost / 模型 / `lab.client.id`。
3. finops 把属性映射成 `Usage`，优先采用网关算好的金额，落库 `usage_events` 并累加 `clients.spent_micros`（供鉴权侧预算检查）。

## 二、安装部署

> 前提：已获取 `feat/agentgateway-extauth-finops` 分支代码；PostgreSQL 已按 `02-postgres.yaml` 就绪。每完成一个步骤就执行对应检查，不要等所有命令执行完后再统一排错。

### 2.1 部署计费服务

```bash
kubectl apply -f apps/agentgateway-lab/deploy/k8s/04-finops.yaml
```

```bash
kubectl -n agentgateway-demo get deploy finops
```

**通过标准：** `finops` 副本 `READY 1/1`，日志出现 `finops OTLP/gRPC ingest listening on :9101`。

### 2.2 打开结构化访问日志（计费主路径）

```yaml
apiVersion: agentgateway.dev/v1alpha1
kind: AgentgatewayPolicy
metadata:
  name: gateway-access-log
  namespace: agentgateway-demo
spec:
  targetRefs:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: agentgateway-demo
  frontend:
    accessLog:
      attributes:
        add:
        - name: lab.client.id
          expression: 'request.headers["x-client-id"]'
      otlp:
        backendRef:
          name: finops
          port: 9101
        protocol: GRPC
```

`lab.client.id` 取自 extAuth 注入的 `x-client-id` 头，所以计费侧不需要回调鉴权服务就能知道这笔钱算给谁。网关对 `protocol=llm` 的请求会带上以下属性：

| 属性 | 含义 |
| --- | --- |
| `gen_ai.usage.input_tokens` / `output_tokens` | 输入 / 输出 token |
| `gen_ai.usage.cache_read.input_tokens` | 命中缓存的输入 token（注意是带点号的形式） |
| `agw.ai.usage.cost.total` • `cost.input/output/cache_read` | 网关按价格目录算出的 realized cost（USD） |
| `gen_ai.request.model` / `gen_ai.provider.name` | 模型与供应商 |
| `route` / `gateway` / `protocol` | 归属，用于按路由对账 |

**通过标准：** `kubectl logs deploy/finops` 出现 `otlp log: client=… model=… in=… out=… cached=…`。

### 2.3 打开链路追踪（争议取证）

```yaml
spec:
  frontend:
    tracing:
      protocol: GRPC
      backendRef:
        name: finops
        port: 9101
      randomSampling: "1"
      attributes:
        add:
        - name: lab.client.id
          expression: 'request.headers["x-client-id"]'
      resources:
      - name: lab.cost.mode
        expression: '"realized-from-catalog"'
```

两个易错点：

- `randomSampling` 是字符串字段，必须写 `"1"` 而不是数字 1。
- `frontend.tracing.resources` 是**平铺列表**，元素为 `name` + `expression`（CEL 表达式），没有 `attributes.add` 那样的 `add:` 包装；`value` 同样按 CEL 求值，所以字符串字面量要写成 `'"realized-from-catalog"'`。

每个 LLM 请求产生一个 server span，带 client / model / tokens / cost / 延迟；`ExtAuthz` 的 span 单独存在，便于区分"鉴权耗时"和"模型耗时"。

**通过标准：** `GET finops:9100/v1/traces/summary` 能查到 server span，且 `ExtAuthz` span 与模型 span 分开。

### 2.4 打开指标标签

```yaml
spec:
  frontend:
    metrics:
      attributes:
        add:
        - name: client_id
          expression: 'request.headers["x-client-id"]'
```

`:15020/metrics` 上有 `agentgateway_gen_ai_client_token_usage`（`gen_ai_token_type` = `input` / `input_cache_read` / `output` 等），带 `gen_ai_system`、`gen_ai_request_model`、`route`、`gateway` 以及上面加的自定义 label。

**通过标准：** `curl localhost:15020/metrics | grep gen_ai_client_token_usage` 出现 `client_id="alice"` 标签。

### 2.5 价格目录

```json
{
  "providers": {
    "openai": {
      "models": {
        "lab-model": { "rates": { "input": "3", "output": "12", "cacheRead": "1" } }
      }
    }
  }
}
```

- 单位是 **USD / 1M tokens**，值是字符串，避免浮点。
- 放在 ConfigMap，通过 Gateway 级 `AgentgatewayParameters.spec.modelCatalog.sources[]` 引用；**只有 Gateway 级 parametersRef 生效**，GatewayClass 级会忽略 ConfigMap。
- 改价格只需更新 ConfigMap，不需要重启数据面。

**通过标准：** `kubectl -n agentgateway-demo get configmap lab-model-catalog -o jsonpath='{.data.catalog\.json}'` 与基线一致。

### 2.6 计费核心代码

金额计算收敛在 `internal/billing/cost.go`：

```go
// 金额单位是整数 micro-USD（1e-6 USD），
// 每个中间值都是整数，chargeback 累计不会因浮点漂移
func CostFromCatalog(u Usage, p Price) int64 {
	cached := u.CachedTokens
	if cached > u.InputTokens {
		cached = u.InputTokens
	}
	uncached := u.InputTokens - cached
	cost := uncached*p.InputMicrosPerTok + cached*p.CacheReadMicrosPerTok + u.OutputTokens*p.OutputMicrosPerTok
	return cost
}

// 优先采用网关上报的 realized cost，保证与网关自带指标不漂移；
// 网关没定价（HasRealizedCost=false）时才回退本地价格目录
func TotalCost(u Usage, p *Price) int64 {
	if u.HasRealizedCost {
		return u.RealizedCostMicros
	}
	if p == nil {
		return 0
	}
	return CostFromCatalog(u, *p)
}
```

落库是"写 usage_event + 累加已花费预算"同一个事务，保证鉴权侧的预算检查能看到最新数：

```go
func (s *Store) InsertUsage(ctx context.Context, u Usage, costMicros int64) error {
	tx, _ := s.pool.Begin(ctx)
	_, err := tx.Exec(ctx, `INSERT INTO usage_events
(time, request_id, client_id, tenant, model, provider,
 input_tokens, output_tokens, cached_tokens, realized_cost_micros, source)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, /* … */)
	if u.ClientID != "" {
		_, err = tx.Exec(ctx, `UPDATE clients SET spent_micros = spent_micros + $2 WHERE client_id = $1`,
			u.ClientID, costMicros)
	}
	return tx.Commit(ctx)
}
```

trace 侧按 `(trace_id, span_id)` 做主键去重，OTLP 重试不会重复计费：

```go
INSERT INTO traces (trace_id, span_id, …)
VALUES (…)
ON CONFLICT (trace_id, span_id) DO NOTHING
```

### 2.7 落库结构

```sql
usage_events(time, request_id, client_id, tenant, model, provider,
             input_tokens, output_tokens, cached_tokens, realized_cost_micros, source)
traces(received_at, trace_id, span_id, name, service, route, client_id, model,
       duration_ms, status_code, cost_micros, input_tokens, output_tokens, attrs jsonb)
auth_audit(time, client_id, source, allowed, status, reason)
```

- `realized_cost_micros` 优先取网关上报的 `agw.ai.usage.cost.total`，网关没有价格时才回退本地价格目录；这样计费与网关自带指标不会漂移。
- `traces.attrs` 保留原始 span（`jsonb`），争议复核时可还原完整请求瀑布。

## 三、使用验证

### 3.1 发起一次计费请求

```bash
curl -s http://localhost:8080/v1/chat/completions -H 'x-api-key: <alice-key>' \
  -H 'content-type: application/json' \
  -d '{"model":"lab-model","messages":[{"role":"user","content":"hello"}]}'
```

**通过标准：** 返回 `200`，响应体 `usage` 含 `prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens`。

### 3.2 金额一致性核对

实测：`in=46 / cached=46 / out=128`，价格目录 `input=3 / cacheRead=1 / output=12`（USD/1M）。

预期金额 = `0×3 + 46×1 + 128×12 = 1582` micro-USD，即 `0.001582` USD。

```bash
curl -s 'http://localhost:9100/v1/usage/summary?since=2026-11-01T00:00:00Z&client=alice'
```

| 检查项 | 结果 |
| --- | --- |
| `usage_events.realized_cost_micros` | `1582`，与网关日志 `agw.ai.usage.cost.total=0.001582` 完全一致 |
| `clients.spent_micros` | 累加 `1582` |
| `traces` server span | 可查，`cost_micros=1582`，含 client / model / tokens / 延迟 |
| 重复 OTLP 重试 | 不产生重复行（`(trace_id, span_id)` 去重） |

**通过标准：** 计费落库金额与网关日志金额逐位一致。

### 3.3 内外网链路与指标

```bash
curl -s http://localhost:9100/v1/usage/chargeback | head
curl -s localhost:15020/metrics | grep agentgateway_gen_ai_client_token_usage
```

**通过标准：** `/v1/usage/summary` 与 `/v1/usage/chargeback` 返回按 tenant/client/model 聚合的成本；`/metrics` 的 token usage 直方图带 `gen_ai_token_type` 与自定义 `client_id` 标签。

### 3.4 当前边界与风险

- **遥测可丢，转发不可停**：审计写入用带缓冲的 best-effort，队列满就丢弃，绝不阻塞请求路径。账单金额因此是"遥测口径"，不是强一致事务。
- **不要把 extAuth 当计费点**：extAuth 只看得到请求，看不到响应里的 token 用量，用它做精确计费必然漏算。
- 给 OTLP 输出加 `filter` 只发 LLM 流量，避免健康检查把计费表灌满。
- 金额统一用整数 micro-USD，展示层再除以 `1e6` 转美元。

## 四、日常运维

### 4.1 查看状态和日志

```bash
kubectl -n agentgateway-demo logs deploy/finops --tail=50
kubectl -n agentgateway-demo port-forward svc/finops 9100:9100
curl -s localhost:9100/v1/traces/summary
```

**通过标准：** 日志有周期性 `otlp/grpc logs: ingested=N`；`/v1/traces/summary` 返回最近 span。

### 4.2 修改价格

修改前先备份：`kubectl get configmap lab-model-catalog -o yaml > catalog.bak.yaml`。更新 `catalog.json` 后 `kubectl apply`；网关热加载目录，**不需要重启数据面**。改完发起一次请求核对 `realized_cost_micros` 是否按新价计算。

**回滚路径：** `kubectl apply -f catalog.bak.yaml`。

### 4.3 月度账单

月度账单只信 `usage_events.realized_cost_micros`（来源 `agw.ai.usage.cost.total`），本地 `price_catalog` 仅兜底；对账用 `GET /v1/usage/summary?since=<月初>` 按 tenant/client/model 聚合。

## 五、FAQ

- 现象：`usage_events` 里金额与网关 UI 对不上。先查该模型是否在价格目录里（未定价时回退本地目录为 0）；常见原因是 ConfigMap 的 key 不是 `catalog.json` 或没挂在 Gateway 级 `parametersRef`。
- 现象：计费表里出现健康检查流量。先查 OTLP 输出是否配了 `filter`；常见原因是 `/healthz` 路径没被过滤。
- 现象：`metrics` 页面 404。先确认抓的是 `:15020`；`15000` 是 UI/admin 端口（`/config_dump`），不提供 `/metrics`。
- 现象：tracing 策略 apply 后无效。先查 `randomSampling` 是否为字符串 `"1"`、`resources` 是否为平铺列表；常见原因是套用了 `attributes.add` 的 `add:` 包装或把 CEL 字面量写成了裸字符串。
- 现象：同一笔请求在 `traces` 里出现两行。先查主键约束 `(trace_id, span_id)` 是否存在；常见原因是表是手工建的、没带 `ON CONFLICT DO NOTHING`。
- 现象：预算耗尽的 key 还能发出少量请求。这是设计内行为——预算检查在鉴权时点，`spent_micros` 由遥测落库后更新，极端并发下存在短窗口超支；需要严格预算就把 `X-Budget-Remaining-Cents` 接到业务侧软降级。
