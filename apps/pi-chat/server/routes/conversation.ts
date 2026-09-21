import type { ConversationService } from "@server/conversation/service";
import { jsonBody } from "@server/utils";
import type { ConversationConfigUpdate, StreamEvent } from "@shared/types";
import { Hono } from "hono";
export function createConversationRoutes(conversationService: ConversationService) {
  const conversationApp = new Hono();

  conversationApp.post("/", async (ctx) => {
    const managedSession = await conversationService.createConversation();
    const snapshot = await conversationService.snapshot(managedSession.id);
    return ctx.json(snapshot);
  });

  conversationApp.get("/", async (ctx) => {
    const conversationList = await conversationService.list();
    return ctx.json(conversationList);
  });

  conversationApp.get("/:conversationId", async (ctx) => {
    const { conversationId } = ctx.req.param();
    const conversationSnapshot = await conversationService.snapshot(conversationId);
    return ctx.json(conversationSnapshot);
  });

  conversationApp.get("/:conversationId/config", async (ctx) => {
    const { conversationId } = ctx.req.param();
    const conversationConfig = await conversationService.getConfig(conversationId);
    return ctx.json(conversationConfig);
  });

  conversationApp.patch("/:conversationId/config", async (ctx) => {
    const { conversationId } = ctx.req.param();
    const body = await jsonBody<ConversationConfigUpdate>(ctx.req.raw);
    // zod
    const patchedConversationConfig = await conversationService.updateConfig(conversationId, body);
    return ctx.json(patchedConversationConfig);
  });

  conversationApp.delete("/:conversationId", async (ctx) => {
    const { conversationId } = ctx.req.param();
    await conversationService.delete(conversationId);
    return ctx.json({
      deleted: true,
    });
  });

  conversationApp.patch("/:conversationId", async (ctx) => {
    const { conversationId } = ctx.req.param();
    const body = await jsonBody<{ title?: unknown }>(ctx.req.raw);
    if (typeof body.title !== "string") {
      throw new Error("Title should be a valid string");
    }
    const patchedConversation = await conversationService.rename(conversationId, body.title);
    return ctx.json(patchedConversation);
  });

  conversationApp.post("/:conversationId/abort", async (ctx) => {
    const { conversationId } = ctx.req.param();
    await conversationService.abort(conversationId);
    return ctx.json({
      aborted: true,
    });
  });

  conversationApp.post("/:conversationId/browser/open", async (ctx) => ctx.json({}));

  const browserActions = {
    close: (_id: string) => {},
    save: (_id: string) => {},
    load: (_id: string) => {},
  };
  for (const [name, run] of Object.entries(browserActions)) {
    conversationApp.post(`/:conversationId/browser/${name}`, async (ctx) => {
      await run(ctx.req.param("conversationId"));
      return ctx.json({ accepted: true });
    });
  }

  conversationApp.post("/:conversationId/messages", async (ctx) => {
    const formData = await ctx.req.formData();
    const { conversationId } = ctx.req.param();
    const userInput = formData.get("text") as string;
    const skillsRaw = formData.get("skills") as string | null;
    let skills: string[] = [];
    if (skillsRaw) {
      try {
        skills = JSON.parse(skillsRaw) as string[];
      } catch {
        // ignore malformed skills
      }
    }
    await conversationService.send(conversationId, userInput, skills);
    return ctx.json({ accepted: true }, 202);
  });

  conversationApp.get("/:conversationId/stream", (ctx) => {
    const { conversationId } = ctx.req.param();
    const afterQuery = ctx.req.query("after") ?? "0";
    const after =
      afterQuery === "latest"
        ? conversationService.getEventChannel(conversationId).lastId
        : Number(afterQuery);
    const safeAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0;

    let unsubscribe: () => void;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const channel = conversationService.getEventChannel(conversationId);
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        // Flush headers through proxies even when there are no events to replay.
        // The client waits for EventSource.onopen before loading the snapshot.
        controller.enqueue(encoder.encode(": connected\n\n"));
        const send = (event: StreamEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        const { events } = channel.replay(safeAfter);
        for (const event of events) {
          send(event);
        }
        unsubscribe = channel.subscribe(send);
        heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
      },
      cancel: () => {
        unsubscribe?.();
        if (heartbeat) {
          clearInterval(heartbeat);
        }
      },
    });
    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return conversationApp;
}
