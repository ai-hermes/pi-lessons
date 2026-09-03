# pi-lessons

基于 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的 Pi Chat 学习项目，包含 React 前端和 Hono 服务端。

## 快速开始

```bash
pnpm install
cp apps/pi-chat/.env.example apps/pi-chat/.env
pnpm dev:pi-chat
```

服务默认监听 `http://127.0.0.1:4328`。

## 配置

`apps/pi-chat/.env` 可设置日志级别、监听地址和端口。模型与 Provider 凭据由本地 Pi 配置管理。

会话、记录和工作区数据默认保存在 `~/.pi/agent/pi-chat`，可通过 `PI_CHAT_ROOT_DIR` 修改。

## 安全

不要提交 `.env`、API Key、会话记录或本机路径；提交配置示例时使用占位值。

## 许可

ISC
