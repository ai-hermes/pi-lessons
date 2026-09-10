import type { ConversationService } from "@server/conversation/service";
import type { BootstrapData } from "@shared/types";
import { Hono } from "hono";

export function createSystemRoutes(conversationService: ConversationService) {
  const systemApp = new Hono();

  systemApp.get("/health", (ctx) => {
    return ctx.json({
      status: "ok",
    });
  });

  systemApp.get("/bootstrap", (ctx) => {
    const bootstrap: BootstrapData = {
      models: conversationService.getAvailableModels(),
      skills: conversationService.getAvailableSkills(),
    };
    return ctx.json(bootstrap);
  });

  return systemApp;
}
