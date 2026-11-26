# loom K8s 清单（st2-aii / kind `agentgateway`）

按文件名顺序 apply；`IMAGE_TAG` 由 `deploy/deploy.sh` 用 `sed` 替换。ConfigMap（`loom-config`、`loom-pricing`、`loom-catalog`、`loom-seed`）由脚本从 `configs/` 与 `make catalog` 生成，不在本目录维护。

| 文件 | 内容 |
| --- | --- |
| `00-namespace.yaml` | Namespace `loom` |
| `01-gateway.yaml` | Gateway `loom-gateway` + `AgentgatewayParameters`（NodePort `30080`、`modelCatalog`） |
| `03-secret.yaml` | PG DSN、admin token（演示占位） |
| `04-postgres.yaml` | PostgreSQL 15 + PVC |
| `05-loom.yaml` | loom Deployment（2 副本 + PDB）+ Service + SA |
| `05b-seed-job.yaml` | 幂等 seed Job |
| `06-backends.yaml` | loom-mock + `AgentgatewayBackend` × 2 |
| `07-routes.yaml` | HTTPRoute × 6 |
| `08-policies.yaml` | extAuth（HTTP/gRPC）、凭据头清理、媒体限流、重试、RLS 同步结算（`rateLimit.global` + `cost: llm.*`） |
| `09-telemetry.yaml` | Gateway 级 access log / tracing / metrics 标签 |

注意：Gateway 不能命名为 `loom`，controller 会以 Gateway 名创建同名 Deployment。
