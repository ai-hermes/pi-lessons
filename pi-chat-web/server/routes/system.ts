import { Hono } from "hono";
import type { ConversationService } from "@server/conversations";
import { ConversationError } from "@server/errors";
import type { GlobalQueueSettings } from "@shared/types";

export function createSystemRoutes(service: ConversationService): Hono {
  return new Hono()
    .get("/health", (context) => context.json({ ok: true }))
    .get("/bootstrap", async (context) => context.json(await service.bootstrap()))
    .get("/settings/queue", async (context) => context.json(await service.getGlobalQueueSettings()))
    .patch("/settings/queue", async (context) => {
      const body = await jsonBody<Partial<GlobalQueueSettings>>(context.req.raw);
      return context.json(await service.updateGlobalQueueSettings(body));
    })
    .get("/settings/tools", async (context) => context.json(await service.getGlobalToolSettings()))
    .patch("/settings/tools", async (context) => {
      const body = await jsonBody<{ name?: unknown; enabled?: unknown }>(context.req.raw);
      if (typeof body.name !== "string") throw new ConversationError("工具名称无效。");
      if (typeof body.enabled !== "boolean") throw new ConversationError("enabled 必须是布尔值。");
      return context.json(await service.updateGlobalTool(body.name, body.enabled));
    });
}

async function jsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    return {} as T;
  }
}
