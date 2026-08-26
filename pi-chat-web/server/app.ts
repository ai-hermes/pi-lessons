import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { ConversationService } from "@server/conversations";
import { ConversationError } from "@server/errors";
import { createConversationRoutes } from "@server/routes/conversations";
import { createSystemRoutes } from "@server/routes/system";

export function createApp(service: ConversationService): Hono {
  const app = new Hono();

  app.route("/api", createSystemRoutes(service));
  app.route("/api/conversations", createConversationRoutes(service));

  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  if (existsSync(dist)) {
    app.use("/assets/*", serveStatic({ root: dist }));
    app.get("*", serveStatic({ path: resolve(dist, "index.html") }));
  }

  app.onError((error, context) => {
    const status = error instanceof ConversationError ? error.status : 500;
    if (status === 500) console.error(error);
    const message = status === 500 ? "Unexpected server error." : error.message;
    if (status === 404) return context.json({ error: message }, 404);
    if (status === 409) return context.json({ error: message }, 409);
    if (status === 413) return context.json({ error: message }, 413);
    return context.json({ error: message }, status === 400 ? 400 : 500);
  });

  return app;
}
