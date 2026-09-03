# pi-lessons

基于 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK 的 TypeScript 学习示例，覆盖会话、工具、技能、扩展、视觉模型和 Web 聊天界面。

## 前置条件

- Node.js 22+
- pnpm
- DeepSeek API Key（运行根目录示例时需要）

## 快速开始

```bash
pnpm install
cp .env.example .env
```

在 `.env` 中填写 `DEEPSEEK_API_KEY`；可选设置 `DEEPSEEK_MODEL`，默认使用 `deepseek-v4-flash`。

## 运行

```bash
# 运行单个 SDK 示例
node --experimental-strip-types 01.ts

# 启动 pi 的 TUI，并加载 04-tui.ts 扩展
pnpm dev:04

# 启动 Web 聊天界面
pnpm dev:pi-chat
```

Web 聊天界面默认监听 `http://127.0.0.1:4328`；其本地配置见 `apps/pi-chat/.env.example`。

## 示例

| 文件 | 内容 |
| --- | --- |
| `01.ts`–`03.ts` | 创建会话、订阅事件与控制内置工具 |
| `04.ts` / `04-tui.ts` | 定义自定义工具，并作为 pi TUI 扩展加载 |
| `05.ts` / `05-local.ts` | 加载技能 |
| `06.ts` / `07.ts` | 覆盖与追加系统提示词 |
| `08.ts` | 内联扩展与工具调用拦截 |
| `09.ts` | 持久化和恢复会话 |
| `10-prepare.ts` | 创建支持新建、恢复、分叉的会话运行时 |
| `01-vision.ts` | 向视觉模型发送本地图片 |
| `apps/pi-chat/` | React + Hono 的 Web 聊天界面 |
| `extensions/pi-volcengine/` | 火山方舟 provider 扩展示例 |

## 许可

ISC
