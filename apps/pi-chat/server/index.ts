import { serve } from '@hono/node-server';
import { createApp } from '@server/app';

const app = createApp();
const host = process.env.PI_CHAT_HOST ?? '127.0.0.1';
const port = Number(process.env.PI_CHAT_PORT ?? 4328);
const server = serve(
    {
        fetch: app.fetch,
        hostname: host,
        port
    },
    (info) => {
        process.stdout.write(
            `Pi Chat API listening on http://${host}:${info.port}\n`,
        );
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

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
