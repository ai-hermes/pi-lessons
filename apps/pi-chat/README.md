# Pi Chat

React + Hono 的本地 Pi Chat 应用。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

默认地址为 `http://127.0.0.1:4328`。会话数据默认保存到 `~/.pi/agent/pi-chat`，可用 `PI_CHAT_ROOT_DIR` 修改。

不要提交 `.env`、API Key 或会话数据。
