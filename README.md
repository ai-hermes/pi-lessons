# pi-lessons

基于 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK 的学习与实践教程。

## 内容

- `01.ts` ~ `09.ts` — pi 编码代理 SDK 的系列练习（会话创建、TUI、本地模型、视觉等）
- `01-vision.ts` — 视觉模型调用示例
- `extensions/` — pi 扩展开发（含火山方舟 pi-volcengine 示例）
- `pi-chat-web/` — 基于 pi 的 Web 聊天界面（pnpm workspace）

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入你的 API Key
```

## 运行示例

```bash
# 单个练习脚本（需 Node 22+ 与 TypeScript）
node --experimental-strip-types 01.ts

# pi-chat-web 开发模式
pnpm dev:pi-chat-web
```

## 许可

ISC
