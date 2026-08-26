// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@shared/types";
import { createApp } from "@server/app";
import type { ConversationService } from "@server/conversations";

describe("conversation import route", () => {
  it("accepts a multipart JSONL file and returns the imported snapshot", async () => {
    const snapshot = { conversation: { id: "imported-id" } } as ConversationSnapshot;
    const importConversation = vi.fn().mockResolvedValue(snapshot);
    const app = createApp({ importConversation } as unknown as ConversationService);
    const boundary = "pi-chat-import-boundary";
    const jsonl = `${JSON.stringify({ type: "session", version: 3, id: "source", timestamp: new Date().toISOString(), cwd: "/tmp/source" })}\n`;
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="history.jsonl"',
      "Content-Type: application/x-ndjson",
      "",
      jsonl,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const response = await app.request("/api/conversations/import", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(snapshot);
    expect(importConversation).toHaveBeenCalledOnce();
    expect(importConversation.mock.calls[0][0]).toMatchObject({ name: "history.jsonl", type: "application/x-ndjson" });
  });

  it("rejects a request without a file", async () => {
    const importConversation = vi.fn();
    const app = createApp({ importConversation } as unknown as ConversationService);
    const form = new FormData();

    const response = await app.request("/api/conversations/import", { method: "POST", body: form });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "请选择 Pi Session JSONL 文件。" });
    expect(importConversation).not.toHaveBeenCalled();
  });
});

describe("tool settings routes", () => {
  it("returns and updates global and conversation tool settings", async () => {
    const view = { defaultEnabled: true, tools: [] };
    const getToolSettings = vi.fn().mockResolvedValue(view);
    const getGlobalToolSettings = vi.fn().mockResolvedValue(view);
    const updateGlobalTool = vi.fn().mockResolvedValue(view);
    const updateConversationTool = vi.fn().mockResolvedValue(view);
    const app = createApp({ getToolSettings, getGlobalToolSettings, updateGlobalTool, updateConversationTool } as unknown as ConversationService);

    expect((await app.request("/api/conversations/c1/tools")).status).toBe(200);
    expect((await app.request("/api/settings/tools")).status).toBe(200);
    const globalResponse = await app.request("/api/settings/tools", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "web_search", enabled: false }),
    });
    const conversationResponse = await app.request("/api/conversations/c1/tools", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "web_search", enabled: null }),
    });

    expect(globalResponse.status).toBe(200);
    expect(conversationResponse.status).toBe(200);
    expect(getGlobalToolSettings).toHaveBeenCalledOnce();
    expect(updateGlobalTool).toHaveBeenCalledWith("web_search", false);
    expect(updateConversationTool).toHaveBeenCalledWith("c1", "web_search", null);
  });

  it("rejects malformed tool settings requests", async () => {
    const app = createApp({} as ConversationService);
    const response = await app.request("/api/conversations/c1/tools", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "web_search", enabled: "yes" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("queue settings routes", () => {
  it("returns and updates global queue defaults", async () => {
    const view = { steeringMode: "all", followUpMode: "one-at-a-time" };
    const getGlobalQueueSettings = vi.fn().mockResolvedValue(view);
    const updateGlobalQueueSettings = vi.fn().mockResolvedValue(view);
    const app = createApp({ getGlobalQueueSettings, updateGlobalQueueSettings } as unknown as ConversationService);

    expect((await app.request("/api/settings/queue")).status).toBe(200);
    const response = await app.request("/api/settings/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steeringMode: "one-at-a-time" }),
    });

    expect(response.status).toBe(200);
    expect(getGlobalQueueSettings).toHaveBeenCalledOnce();
    expect(updateGlobalQueueSettings).toHaveBeenCalledWith({ steeringMode: "one-at-a-time" });
  });
});
