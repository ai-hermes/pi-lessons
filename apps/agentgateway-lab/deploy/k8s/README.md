# lab 清单

按文件名顺序 apply（`kubectl apply -f dir/` 也会按字母序）：

| 文件 | 内容 |
| --- | --- |
| `00-platform.yaml` | namespace、echo、Gateway + `AgentgatewayParameters`（NodePort 30080、modelCatalog）、`lab-model-catalog` ConfigMap、`/echo` Route |
| `01-lab-secrets.yaml` | PG DSN、admin token、JWT secret |
| `02-postgres.yaml` | PostgreSQL + init SQL（clients / sessions / auth_audit / price_catalog / usage_events + demo 客户端） |
| `03-extauth.yaml` | 鉴权服务（HTTP :9001，gRPC :9002） |
| `04-finops.yaml` | 计费服务（HTTP :9100，OTLP/gRPC :9101） |
| `05-policies.yaml` | `/echo` 的 `extAuth.http`；Gateway 级 `accessLog.otlp` → finops |
| `06-llm-route.yaml` | `AgentgatewayBackend`（伪 OpenAI）+ `/v1` Route + 该 Route 的 extAuth |
| `07-extauth-grpc.yaml` | `/grpc` Route + `extAuth.grpc`（Envoy ext_authz v3） |
| `08-tracing.yaml` | Gateway 级 tracing → finops:9101；metrics 自定义 `client_id` 标签 |

demo key（真实环境不可用）：

| client | auth | 预期 |
| --- | --- | --- |
| `sk-lab-alice` | api key | 200 |
| `sk-lab-bob` | api key，预算已耗尽 | 429 `budget_exhausted` |
| `sk-lab-carol` | api key，`status=disabled` | 403 `client_inactive` |
