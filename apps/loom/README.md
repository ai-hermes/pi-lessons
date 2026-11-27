# loom — extAuth + billing for AgentGateway

织机（loom）：把多家模型「编织」成一张网。loom 是 AgentGateway 的外挂鉴权（`extAuth`）与计费服务：
API Key 与额度不放在网关 Secret 里，而是由 loom 在 PostgreSQL 中管理；每个请求按 one-api 口径的计价表
在准入时预扣、在响应完成后结算，额度不足在准入阶段直接 `403`。术语见 [GLOSSARY.md](./GLOSSARY.md)。

```txt
client ──key + body──► agentgateway ──extauth──► loom :8080 /check ── admission: 凭据→Key→模型→定价→预扣 ──► 放行 + identity headers
                          │ headerModifiers 删凭据头
                          ▼
                     LLM backend ── usage ──┬─► RateLimitService amend（每请求同步）──► loom :8080 ──┐
                                           └─► OTLP access log（补账）────────────────► loom :8080 ──┴─► ledger.Settle（同一 request_id 幂等）
```

## 端口

| 端口 | 用途 | 谁访问 |
| --- | --- | --- |
| `8080` 数据面（h2c） | extauth HTTP `/check` 与 gRPC `ext_authz`、RateLimitService 结算、OTLP 补账、gRPC health | 只有网关 |
| `9090` 运维面 | 管理 API `/v1/*`、`/metrics`、`/healthz`、`/readyz`、`/debug/pprof` | 运维 / Prometheus |

## 计价（one-api 口径）

| 字段 | 含义 |
| --- | --- |
| `model_ratio` | 倍率，`1` = `$2 / 1M input tokens` = `2000 nano-USD / token` |
| `completion_ratio` / `cache_ratio` | 输出 / 缓存命中相对输入单价的倍率 |
| `model_price` | 按次计费（USD/次），填写后优先于倍率 |
| `groups.<g>.ratio` | 分组倍率（账户 `group`） |

取值口径与 one-api / new-api 一致：**未填写**取 `defaults`（分组取 1）；**`0` 表示免费**（`model_ratio: 0` 免费模型、`completion_ratio: 0` 输出免费、`model_price: 0` 按次免费、分组 `ratio: 0` 免费分组），免费请求不预扣；**负数**让配置加载失败（热加载时保留旧价目表）。PG `model_pricing` 与管理 API `PUT /v1/pricing/:model` 同口径：未传的倍率取 1。

分组：`default` 分组总是存在（没写时倍率为 1）。账户分组必须在 `groups` 里定义——管理 API / `seed` 写入时校验（`400`），准入时按 `defaults.unknown_group` 处理：`deny`（默认）拒绝并返回 `group_not_priced`，`default` 按 `default` 分组计价；结算时遇到已被删除的分组按 `default` 分组结算。

精度与留痕：单 token 单价保留小数，整笔请求算完只取整一次；每条 `usage_events` 记录计价快照（`pricing_group`、`group_ratio`、`model_ratio`、`completion_ratio`、`cache_ratio`、`model_price`），可以离线复核金额。`cost_source: gateway_prefer` 时用网关金额 × 分组倍率。

金额是整数 nano-USD（`1 USD = 1e9`）：`cost = (in − cached) × p_in + cached × p_cache + out × p_out`。
查价顺序：`pricing.yaml`（ConfigMap）→ PG `model_pricing` → `defaults.unknown_model`（`deny` 或 `default`）。

## 代码结构（按能力分包）

```text
cmd/
├── loom/              cobra 子命令：serve | migrate | seed | render-catalog | check-config | version
└── loom-mock/         伪 OpenAI 后端（chat / embeddings / images / echo），验收用
internal/
├── admission/         准入门 Gate：凭据 → Key → 状态 → 模型 → 定价 → 预扣，输出 Verdict（与协议无关）
├── ledger/            额度账本：Reserve（预扣）/ Settle（结算）/ RunReaper（过期释放）
├── pricing/           价目表 Table：pricing.yaml 热加载 + PG 兜底，Card 单价卡，网关 catalog 渲染
├── account/           管理操作：账户、Key、兜底定价、用量查询、seed
├── transport/         协议适配，只做线上格式 ↔ 领域类型的翻译
│   ├── extauth/       HTTP /check + Envoy ext_authz.v3
│   ├── ratelimit/     Envoy RateLimitService（amend → ledger.Settle）
│   ├── otlp/          OTLP access log → 补账队列 → ledger.Settle
│   └── adminapi/      gin 管理 API → account.Service
├── app/               装配与生命周期：连库迁移、两个端口、后台任务、优雅停机
├── store/             领域记录与持久化接口；postgres/（sqlc + goose）、memstore/（单测）
├── config/            配置加载（默认值 → yaml → LOOM_* 环境变量）
└── telemetry/         slog 与 Prometheus 指标
configs/               config.yaml · pricing.yaml · seed.yaml
migrations/            goose SQL（embed 进二进制）
deploy/                k8s 清单 · deploy.sh · smoke.sh · contract.sh · bench.sh · monitoring/ · Dockerfile
```

依赖方向：`transport → admission / ledger / account → pricing → store`；`app` 负责把它们接起来。
业务包只依赖自己声明的窄接口（如 `admission.Store`、`ledger.Pricer`），不依赖 `store.Store` 全量接口。

## 快速开始

```bash
make test lint                            # 单测（-race）+ golangci-lint
make check                                # 校验配置并打印价目表
deploy/deploy.sh --fresh --tag v0.5.0     # 部署到 st2-aii
deploy/smoke.sh                           # 验收：RESULT: PASS=84 FAIL=0
deploy/contract.sh                        # AgentGateway 契约测试：RESULT: PASS=30 FAIL=0
deploy/bench.sh                           # 压测基线（单账户 / 多账户，按并发分档）
deploy/monitoring/check.sh                # 告警规则校验（promtool + kind 内最小 Prometheus）
```

运维手册（安装、验证、管理 API、改价、FAQ）见 [docs/loom-extauth-billing.md](../../docs/loom-extauth-billing.md)，
实施计划与 TODO 见 [docs/loom-plan.md](../../docs/loom-plan.md)。
