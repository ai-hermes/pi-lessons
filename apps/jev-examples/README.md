# jev-examples

[Jev](https://docs.typesafe.ai/api)（TypeSafe System One）案例集：把「判断题」交给 Jev，用 Choice / Score / Noul 拿到带概率的结构化答案，其余全部由代码负责。案例来自 [Notion · Jev](https://app.notion.com/p/dingwenjiang/Jev-3e325bd1f17780088ef7ee5d8f482a3a)。

```bash
pnpm install
cp apps/jev-examples/.env.example apps/jev-examples/.env   # 填入 TYPESAFE_API_KEY
pnpm --filter jev-examples run 01   # 01 ~ 06，或 all
pnpm --filter jev-examples typecheck
```

## 配置

脚本启动时自动加载 `apps/jev-examples/.env`（已存在的环境变量优先），直接调用 `POST /v1/systemone`，429 / 529 自动退避重试。未设置 `TYPESAFE_API_KEY` 时直接报错退出。

可选变量：`TYPESAFE_BASE_URL`、`JEV_TIMEOUT_MS`（默认 30000）。`.env` 已被 git 忽略，不要提交 Key。

## 案例

| 案例 | 文件 | 问题类型 | 要点 |
| --- | --- | --- | --- |
| 1 | `01-ticket-routing.ts` | Choice + Noul + Score | 工单路由：硬规则先行、置信度阈值、退款标签、SLA，影子模式只给建议 |
| 2 | `02-tool-model-routing.ts` | Choice | 工具 / 模型路由：代码过滤可用选项、强制兜底项、位置偏差检查、参数由代码生成校验 |
| 3 | `03-writing-check.ts` | Noul + Choice + Score | 写作质检：剥离引用 / 代码块、代码规则先行、受众相关的语气判断 |
| 4 | `04-rag-filter.ts` | Noul（批量） | RAG 候选过滤：BM25 + 向量 RRF 召回、去重取最新版本、逐条相关性判断、引用核对 |
| 5 | `05-coding-proposal-review.ts` | Noul + Choice | Coding Agent 提案审查：schema / 路径 / diff 校验、固定模型版本、决策表与审计记录 |
| 6 | `06-browser-action.ts` | Choice（多轮） | 浏览器动作选择：可见元素编号、动态操作集、执行前复核页面版本、卡住检测、代码验证完成 |

`shared/jev.ts` 是公共客户端：请求、重试、答案校验（选项必须在 criteria 内、概率和≈1）。

## 安全边界

Jev 的输出是**决策证据，不是授权**。所有案例都遵循：

- 硬规则、权限、参数和最终执行由代码决定；
- 低置信度、答案缺失或 Jev 不可用时降级（人工 / 仅建议 / 兜底项），不抛给用户；
- 页面内容、文档等不可信输入中的「指令」不会被执行（见案例 6 的 Cookie 横幅注入）。

## 参考

- [Notion · Jev 案例](https://app.notion.com/p/dingwenjiang/Jev-3e325bd1f17780088ef7ee5d8f482a3a)
- [TypeSafe API 文档](https://docs.typesafe.ai/api)
