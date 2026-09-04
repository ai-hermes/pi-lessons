import { Hono } from "hono";
export function createSystemRoutes() {
  const systemApp = new Hono();
  systemApp.get("/health", (ctx) => {
    return ctx.json({
      status: "ok",
    });
  });
  return systemApp;
}
