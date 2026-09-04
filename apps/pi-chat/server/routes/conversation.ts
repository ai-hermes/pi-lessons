import type { ConversationService } from "@server/conversation/service";
import type { StreamEvent } from "@shared/types";
import { Hono } from "hono";
export function createConversationRoutes(
  conversationService: ConversationService,
) {
  const conversationApp = new Hono();

  conversationApp.post("/", async (ctx) => {
    const managedSession = await conversationService.createConversation();
    const snapshot = await conversationService.snapshot(managedSession.id);
    return ctx.json(snapshot);
  });

  conversationApp.get("/:id", async (ctx) => {
    const { id } = ctx.req.param();
    const conversationSnapshot = await conversationService.snapshot(id);
    return ctx.json(conversationSnapshot);
  });

  conversationApp.post("/:conversationId/messages", async (ctx) => {
    const formData = await ctx.req.formData();
    const { conversationId } = ctx.req.param();
    const userInput = formData.get("text") as string;
    await conversationService.send(conversationId, userInput);
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
        const send = (event: StreamEvent) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
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
