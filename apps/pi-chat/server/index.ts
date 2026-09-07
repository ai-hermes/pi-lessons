import { writeFile } from "node:fs/promises";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { serve } from "@hono/node-server";
import { createApp } from "@server/app";
import { ConversationService } from "@server/conversation/service";

import { ensureDir, getGlobalConfig } from "./config";

const globalConfig = getGlobalConfig();
await ensureDir([globalConfig.rootDir]);
await writeFile(globalConfig.mcpConfigPath, JSON.stringify({ mcpServers: {} }, null, 2), {
  flag: "wx",
}).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "EEXIST") throw error;
});
const modelRuntime = await ModelRuntime.create();
const service = new ConversationService(globalConfig, modelRuntime);

const app = createApp(service);
const host = process.env.PI_CHAT_HOST ?? "127.0.0.1";
const port = Number(process.env.PI_CHAT_PORT ?? 4328);
const server = serve(
  {
    fetch: app.fetch,
    hostname: host,
    port,
  },
  (info) => {
    process.stdout.write(`Pi Chat API listening on http://${host}:${info.port}\n`);
  },
);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
}

function handleShutdown() {
  shutdown().catch((error) => {
    process.stderr.write(
      `Shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
