# Pi Chat Web

一个 ChatGPT 风格的本地 Web 应用，用来集中演示 Pi 作为 Agent harness 的能力：持久化会话、恢复、分支、模型与 thinking 切换、图片输入、完整编码工具、steer/follow-up 队列、自动重试、上下文压缩、统计与实时事件。

## 安全警告

这是**本机可信演示，不是沙箱**。Pi Chat 开放 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。虽然每个新对话有独立工作目录，但 Bash 仍可通过绝对路径访问本机其他位置。

- 服务只监听 `127.0.0.1`。
- 不要将它直接暴露到公网。
- 不要让不可信用户使用运行该服务的系统账号。

## 运行

先使用 Pi CLI 完成模型认证，或者在仓库 `.env` 中配置模型供应商 API Key，然后：

```bash
pnpm install
pnpm example:pi-chat-web
```

打开 <http://127.0.0.1:4327>。生产构建与测试：

```bash
pnpm example:pi-chat-web:test
pnpm example:pi-chat-web:build
pnpm --filter @warjiang/pi-chat-web start
```

## 目录约定（源码与测试分离）

- 业务源码位于 `src/`、`server/`、`shared/`。
- 测试代码集中位于 `test/`：

```text
test/
	server/           Node 环境的服务端测试
	src/              前端状态与页面测试
	src/components/   组件测试
```

Vitest 会自动发现 `test/**/*.test.ts` 与 `test/**/*.test.tsx`。

## 数据与配置

默认数据目录为 `~/.pi/agent/web-chat`：

```text
records/       对话元数据
sessions/      Pi JSONL sessions
workspaces/    每个根对话的可写目录；分支共享父对话 workspace
exports/       临时 HTML 导出
```

可用环境变量：

- `PI_CHAT_DATA_DIR`：覆盖数据根目录。
- `PI_CHAT_IDLE_TTL_MS`：runtime 空闲回收时间，默认 `300000`。
- `PI_CHAT_PORT`：API 端口，默认 `4328`。

模型与凭证直接复用 `~/.pi/agent` 以及标准供应商环境变量。网页只列出 `ModelRuntime.getAvailable()` 确认可用的模型，不接收或保存 API Key。

## 架构

- Hono 提供 REST 与可恢复的 SSE 事件流。
- `AgentSessionRuntime` 负责 session 创建、恢复和 fork；`SessionManager` 持久化 JSONL。
- runtime 按需加载，空闲后释放；历史对话和 Agent 上下文不会因此丢失。
- React reducer 消费 Pi 的消息、工具、队列、重试和 compaction 事件；游标失效时重新拉取快照。
- UI 使用官方 shadcn radix-nova、Tailwind CSS v4 与 Lucide。

## 建议演示路径

1. 让 Agent 创建一个小项目，展开查看 Bash 与 edit 工具详情。
2. 运行中发送一条 `Steer`，再发送一条 `排队`，观察 queue 事件。
3. 切换模型和 thinking level，查看 token、费用与 context usage。
4. 上传图片，让支持视觉的模型分析。
5. 手动压缩上下文，然后编辑一条历史用户消息创建分支。
6. 重启服务或等待 runtime 空闲释放，再继续原会话验证恢复。
