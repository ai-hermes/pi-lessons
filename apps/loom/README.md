# loom — extAuth + billing for AgentGateway

织机（loom）：把多家模型「编织」成一张网。loom 是 AgentGateway 的外挂鉴权（`extAuth`）与计费服务：
API Key 与额度不再落在网关 Secret，而是由 loom 在 PostgreSQL 中管理；每个请求按 one-api 口径的计价表算钱并从两级额度（账户 + Key）中扣除，额度不足在鉴权阶段直接 `403`。

```txt
client ──key + body──► agentgateway ──extAuth(forwardBody)──► loom /check ──► sha256 查 Key → 定价 → 原子预扣 → 放行 + identity headers
                          │ headerModifiers 删凭据头
                          ▼
                     LLM backend ── usage ──► access log (OTLP) ──► loom :9101 ──► usage_events + 结算预扣
```

## 计价（one-api 口径）

| 字段 | 含义 |
| --- | --- |
| `model_ratio` | 倍率，`1` = `$2 / 1M input tokens` = `2000 nano-USD / token` |
| `completion_ratio` / `cache_ratio` | 输出 / 缓存命中 token 倍率 |
| `model_price` | 按次计费（USD/次），优先于倍率 |
| `groups.<g>.ratio` | 分组倍率（账户 `group`） |

金额单位为整数 nano-USD（`1 USD = 1e9`）：`cost = (in − cached) × p_in + cached × p_cache + out × p_out`。
定价查找顺序：ConfigMap `pricing.yaml` → PG `model_pricing` → `defaults.unknown_model`（`deny` 或 `default`）。

## 目录

```text
cmd/loom          serve | migrate | render-catalog | check-config | seed
cmd/loom-mock     伪 OpenAI 后端（chat/embeddings/images/echo）
configs/          config.yaml、pricing.yaml、seed.yaml
migrations/       goose SQL（embed）
internal/         auth / quota / pricing / billing / store(pg=sqlc, mem) / admin / server / config / telemetry / cache
deploy/k8s/       00-namespace … 09-telemetry
deploy/deploy.sh  交叉编译 → scp → docker build → kind load → kubectl apply → seed
deploy/smoke.sh   70 项验收矩阵
docs/             ../docs/loom-extauth-billing.md（本仓库 docs/）
```

## 快速开始

```bash
make test vet            # 单测
make check               # 校验配置并打印价目表（需 PG DSN）
deploy/deploy.sh --fresh --tag v0.3.0   # 部署到 st2-aii
deploy/smoke.sh          # 验收：RESULT: PASS=70 FAIL=0
```

运维手册（安装、验证、管理 API、改价、FAQ）见 [docs/loom-extauth-billing.md](../../docs/loom-extauth-billing.md)，实施计划见 [docs/loom-plan.md](../../docs/loom-plan.md)。
