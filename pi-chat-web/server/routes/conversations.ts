import { basename } from "node:path";
import { Hono } from "hono";
import type { ConversationSettingsPatch, ThinkingLevel } from "@shared/types";
import type { ConversationService } from "@server/conversations";
import { ConversationError } from "@server/errors";

export function createConversationRoutes(service: ConversationService): Hono {
  const routes = new Hono();

  routes.get("/", async (context) => context.json(await service.list()));
  routes.post("/", async (context) => context.json(await service.createConversation(), 201));
  routes.post("/import", async (context) => {
    const file = (await context.req.formData()).get("file");
    if (!file || typeof file === "string" || typeof file.text !== "function") {
      throw new ConversationError("请选择 Pi Session JSONL 文件。");
    }
    return context.json(await service.importConversation(file as File), 201);
  });

  routes.get("/:id", async (context) => context.json(await service.snapshot(context.req.param("id"))));
  routes.patch("/:id", async (context) => {
    const body = await jsonBody<{ title?: unknown }>(context.req.raw);
    if (typeof body.title !== "string") throw new ConversationError("缺少标题。");
    return context.json(await service.rename(context.req.param("id"), body.title));
  });
  routes.delete("/:id", async (context) => {
    await service.delete(context.req.param("id"));
    return context.body(null, 204);
  });

  routes.post("/:id/messages", async (context) => {
    const form = await context.req.formData();
    const files = [...form.getAll("files"), ...form.getAll("images")]
      .filter((item): item is File => item instanceof File);
    await service.sendFiles(
      context.req.param("id"),
      String(form.get("text") ?? ""),
      files,
      form.get("behavior") === "steer" ? "steer" : "followUp",
    );
    return context.json({ accepted: true }, 202);
  });

  routes.post("/:id/abort", async (context) => {
    await service.abort(context.req.param("id"));
    return context.json({ aborted: true });
  });
  routes.post("/:id/model", async (context) => {
    const body = await jsonBody<{ provider?: unknown; id?: unknown }>(context.req.raw);
    if (typeof body.provider !== "string" || typeof body.id !== "string") throw new ConversationError("模型参数无效。");
    await service.setModel(context.req.param("id"), body.provider, body.id);
    return context.json({ changed: true });
  });
  routes.post("/:id/thinking", async (context) => {
    const body = await jsonBody<{ level?: unknown }>(context.req.raw);
    if (typeof body.level !== "string") throw new ConversationError("思考级别无效。");
    await service.setThinking(context.req.param("id"), body.level as ThinkingLevel);
    return context.json({ changed: true });
  });
  routes.post("/:id/compact", async (context) => {
    const body = await jsonBody<{ instructions?: unknown }>(context.req.raw);
    await service.compact(context.req.param("id"), typeof body.instructions === "string" ? body.instructions : undefined);
    return context.json({ accepted: true }, 202);
  });
  routes.patch("/:id/settings", async (context) => {
    const body = await jsonBody<ConversationSettingsPatch>(context.req.raw);
    return context.json(await service.updateSettings(context.req.param("id"), body));
  });
  routes.get("/:id/tools", async (context) => context.json(await service.getToolSettings(context.req.param("id"))));
  routes.patch("/:id/tools", async (context) => {
    const body = await jsonBody<{ name?: unknown; enabled?: unknown }>(context.req.raw);
    if (typeof body.name !== "string") throw new ConversationError("工具名称无效。");
    if (body.enabled !== null && typeof body.enabled !== "boolean") throw new ConversationError("enabled 必须是布尔值或 null。");
    return context.json(await service.updateConversationTool(context.req.param("id"), body.name, body.enabled));
  });
  routes.post("/:id/branches", async (context) => {
    const body = await jsonBody<{ entryId?: unknown; text?: unknown }>(context.req.raw);
    if (typeof body.entryId !== "string" || typeof body.text !== "string") throw new ConversationError("分支参数无效。");
    return context.json(await service.branch(context.req.param("id"), body.entryId, body.text), 201);
  });

  routes.get("/:id/events", async (context) => {
    const after = Number(context.req.query("after") ?? 0);
    return service.eventStream(
      context.req.param("id"),
      context.req.query("streamId"),
      Number.isSafeInteger(after) && after >= 0 ? after : 0,
    );
  });
  routes.get("/:id/export", async (context) => {
    const format = context.req.query("format") === "html" ? "html" : "jsonl";
    const result = await service.export(context.req.param("id"), format);
    return context.body(result.content, 200, {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${basename(result.path)}"`,
    });
  });

  return routes;
}

async function jsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    return {} as T;
  }
}
