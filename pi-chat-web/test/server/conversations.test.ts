import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { File as NodeFile } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAttachments, validateImages } from "@server/attachments";
import { ConversationService } from "@server/conversations";
import { MAX_IMPORT_BYTES } from "@server/session-files";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function service(ttlMs = 60_000): Promise<ConversationService> {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-test-"));
  roots.push(root);
  return serviceAt(root, ttlMs);
}

async function serviceAt(root: string, ttlMs = 60_000): Promise<ConversationService> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  await runtime.setRuntimeApiKey("openai", "test-key");
  return ConversationService.create({ dataDir: root, ttlMs, modelRuntime: runtime });
}

describe("ConversationService", () => {
  it("persists metadata and restores a released runtime", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    await conversations.rename(created.conversation.id, "Persistent chat");
    await conversations.release(created.conversation.id);
    expect((await conversations.list())[0]).toMatchObject({ title: "Persistent chat", status: "cold" });
    const restored = await conversations.snapshot(created.conversation.id);
    expect(restored.conversation.title).toBe("Persistent chat");
    expect(restored.status).toBe("ready");
    await conversations.shutdown();
  });

  it("recovers a session when its persisted session path is stale", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    const id = created.conversation.id;
    const active = activeConversation(conversations, id);
    active.runtime.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Keep this history" }],
      timestamp: Date.now(),
    } as never);
    active.runtime.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "History restored" }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as never);

    const recordPath = join(conversations.paths.records, `${id}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { sessionFile: string };
    record.sessionFile = join(conversations.paths.sessions, `missing_${id}.jsonl`);
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
    await conversations.release(id);

    const restored = await conversations.snapshot(id);
    expect(restored.messages.map((message) => message.text)).toEqual(["Keep this history", "History restored"]);
    expect(JSON.parse(await readFile(recordPath, "utf8")).sessionFile).not.toContain(`missing_${id}.jsonl`);
    await conversations.shutdown();
  });

  it("evicts idle runtimes without deleting the conversation", async () => {
    const conversations = await service(10);
    const created = await conversations.createConversation();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await conversations.list())[0].status).toBe("cold");
    await conversations.shutdown();
  });

  it("persists title and settings changes", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    const id = created.conversation.id;
    await conversations.rename(id, "Updated metadata");
    await conversations.updateSettings(id, { autoCompaction: false, autoRetry: false });
    await conversations.release(id);

    const restored = await conversations.snapshot(id);
    expect(restored.conversation.title).toBe("Updated metadata");
    expect(restored.settings).toMatchObject({ autoCompaction: false, autoRetry: false });
    await conversations.shutdown();
  });

  it("applies global queue defaults unless a conversation overrides them", async () => {
    const conversations = await service();
    const inherited = await conversations.createConversation();
    const overridden = await conversations.createConversation();

    await conversations.updateGlobalQueueSettings({ steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" });
    let inheritedSnapshot = await conversations.snapshot(inherited.conversation.id);
    expect(inheritedSnapshot.settings).toMatchObject({
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      queueOverrides: { steeringMode: null, followUpMode: null },
    });

    await conversations.updateSettings(overridden.conversation.id, {
      queueOverrides: { steeringMode: "all", followUpMode: "all" },
    });
    await conversations.updateGlobalQueueSettings({ steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" });
    const overriddenSnapshot = await conversations.snapshot(overridden.conversation.id);
    expect(overriddenSnapshot.settings).toMatchObject({
      steeringMode: "all",
      followUpMode: "all",
      queueDefaults: { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
      queueOverrides: { steeringMode: "all", followUpMode: "all" },
    });

    await conversations.updateSettings(overridden.conversation.id, {
      queueOverrides: { steeringMode: null, followUpMode: null },
    });
    inheritedSnapshot = await conversations.snapshot(overridden.conversation.id);
    expect(inheritedSnapshot.settings).toMatchObject({
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      queueOverrides: { steeringMode: null, followUpMode: null },
    });
    await conversations.shutdown();
  });

  it("persists global queue defaults and conversation overrides across restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-test-"));
    roots.push(root);
    const firstService = await serviceAt(root);
    const created = await firstService.createConversation();
    await firstService.updateGlobalQueueSettings({ steeringMode: "one-at-a-time" });
    await firstService.updateSettings(created.conversation.id, { queueOverrides: { followUpMode: "one-at-a-time" } });
    await firstService.shutdown();

    const restoredService = await serviceAt(root);
    const restored = await restoredService.snapshot(created.conversation.id);
    expect(restored.settings).toMatchObject({
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      queueDefaults: { steeringMode: "one-at-a-time", followUpMode: "all" },
      queueOverrides: { steeringMode: null, followUpMode: "one-at-a-time" },
    });
    await restoredService.shutdown();
  });

  it("loads only application extensions and enables their registered tools by default", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    const expected = ["fetch_content", "get_search_content", "source_check", "web_search"];
    const initial = await conversations.getToolSettings(created.conversation.id);

    expect(initial.tools.filter((tool) => expected.includes(tool.name))).toEqual(
      expect.arrayContaining(expected.map((name) => expect.objectContaining({
        name,
        source: expect.objectContaining({ kind: "extension", label: "pi-web-access" }),
        globalEnabled: true,
        conversationOverride: null,
        effectiveEnabled: true,
      }))),
    );
    expect(activeConversation(conversations, created.conversation.id).runtime.session.getActiveToolNames()).toEqual(
      expect.arrayContaining(expected),
    );

    const extensionDir = join(created.conversation.workspace, ".pi", "extensions");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "project-only.ts"), `
      export default function (pi) {
        pi.registerTool({
          name: "project_only_tool",
          description: "must not load",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "unexpected" }] }),
        });
      }
    `, "utf8");
    await conversations.release(created.conversation.id);

    expect((await conversations.getToolSettings(created.conversation.id)).tools.map((tool) => tool.name)).not.toContain("project_only_tool");
    await conversations.shutdown();
  });

  it("applies global defaults and conversation overrides to active tools", async () => {
    const conversations = await service();
    const first = await conversations.createConversation();
    const second = await conversations.createConversation();

    await conversations.updateGlobalTool("web_search", false);
    expect(activeConversation(conversations, first.conversation.id).runtime.session.getActiveToolNames()).not.toContain("web_search");
    expect(activeConversation(conversations, second.conversation.id).runtime.session.getActiveToolNames()).not.toContain("web_search");

    let view = await conversations.updateConversationTool(first.conversation.id, "web_search", true);
    expect(view.tools.find((tool) => tool.name === "web_search")).toMatchObject({
      globalEnabled: false,
      conversationOverride: true,
      effectiveEnabled: true,
    });
    expect(activeConversation(conversations, first.conversation.id).runtime.session.getActiveToolNames()).toContain("web_search");
    expect(activeConversation(conversations, second.conversation.id).runtime.session.getActiveToolNames()).not.toContain("web_search");

    view = await conversations.updateConversationTool(first.conversation.id, "web_search", null);
    expect(view.tools.find((tool) => tool.name === "web_search")).toMatchObject({
      conversationOverride: null,
      effectiveEnabled: false,
    });

    await conversations.updateGlobalTool("web_search", true);
    view = await conversations.updateConversationTool(first.conversation.id, "web_search", false);
    expect(view.tools.find((tool) => tool.name === "web_search")).toMatchObject({
      globalEnabled: true,
      conversationOverride: false,
      effectiveEnabled: false,
    });

    await expect(conversations.updateConversationTool(first.conversation.id, "missing_tool", true)).rejects.toMatchObject({ status: 404 });
    await conversations.shutdown();
  });

  it("persists global and conversation tool settings across service restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-test-"));
    roots.push(root);
    const firstService = await serviceAt(root);
    const created = await firstService.createConversation();
    await firstService.updateGlobalTool("web_search", false);
    await firstService.updateConversationTool(created.conversation.id, "web_search", true);
    await firstService.shutdown();

    const restoredService = await serviceAt(root);
    const restored = await restoredService.getToolSettings(created.conversation.id);
    expect(restored.tools.find((tool) => tool.name === "web_search")).toMatchObject({
      globalEnabled: false,
      conversationOverride: true,
      effectiveEnabled: true,
    });
    expect(activeConversation(restoredService, created.conversation.id).runtime.session.getActiveToolNames()).toContain("web_search");
    await restoredService.shutdown();
  });

  it("updates global tool settings without an explicit conversation context", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    await conversations.release(created.conversation.id);

    const view = await conversations.updateGlobalTool("web_search", false);

    expect(view.tools.find((tool) => tool.name === "web_search")).toMatchObject({
      enabled: false,
    });
    expect(activeConversation(conversations, created.conversation.id).runtime.session.getActiveToolNames()).not.toContain("web_search");
    await conversations.shutdown();
  });

  it("copies conversation tool overrides into branches", async () => {
    const conversations = await service();
    const source = await conversations.createConversation();
    await conversations.updateConversationTool(source.conversation.id, "web_search", false);
    const active = activeConversation(conversations, source.conversation.id);
    const entryId = active.runtime.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Create a branch" }],
      timestamp: Date.now(),
    } as never);
    active.runtime.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Ready to branch." }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as never);
    vi.spyOn(active.runtime.session, "followUp").mockResolvedValue(undefined);

    const branched = await conversations.branch(source.conversation.id, entryId, "Continue without search");
    expect((await conversations.getToolSettings(branched.conversation.id)).tools.find((tool) => tool.name === "web_search")).toMatchObject({
      conversationOverride: false,
      effectiveEnabled: false,
    });
    await conversations.shutdown();
  });

  it("generates and broadcasts a title from the first user request", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    const id = created.conversation.id;
    const active = activeConversation(conversations, id);
    const prompt = vi.spyOn(active.runtime.session, "prompt").mockResolvedValue(undefined);

    await conversations.send(id, "  帮我\n优化一下工具调用界面  ", [], "followUp");

    expect(prompt).toHaveBeenCalledWith("帮我\n优化一下工具调用界面", expect.any(Object));
    expect((await conversations.snapshot(id)).conversation.title).toBe("帮我 优化一下工具调用界面");
    expect(active.runtime.session.sessionManager.getSessionName()).toBe("帮我 优化一下工具调用界面");
    expect(active.events.activity().at(-1)).toMatchObject({ type: "conversation.renamed", summary: "conversation.renamed" });
    await conversations.shutdown();
  });

  it("does not duplicate transcript-backed activity after a snapshot refresh", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    const active = activeConversation(conversations, created.conversation.id);
    const timestamp = Date.now();
    const entryId = active.runtime.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Keep one activity row" }],
      timestamp,
    } as never);
    active.events.publish("message.added", {
      message: { id: entryId, role: "user", text: "Keep one activity row", images: [], timestamp },
    });

    const snapshot = await conversations.snapshot(created.conversation.id);
    const activities = snapshot.activity.filter((item) => item.type === "message.added" && item.sourceId === entryId);
    expect(activities).toEqual([expect.objectContaining({ summary: "用户消息" })]);
    await conversations.shutdown();
  });

  it("routes messages to the selected running queue", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    const active = activeConversation(conversations, created.conversation.id);
    active.status = "running";
    const steer = vi.spyOn(active.runtime.session, "steer").mockResolvedValue(undefined);
    const followUp = vi.spyOn(active.runtime.session, "followUp").mockResolvedValue(undefined);

    await conversations.send(created.conversation.id, "redirect", [], "steer");
    await conversations.send(created.conversation.id, "next", [], "followUp");
    expect(steer).toHaveBeenCalledWith("redirect", []);
    expect(followUp).toHaveBeenCalledWith("next", []);
    active.status = "ready";
    await conversations.shutdown();
  });

  it("rejects busy mutations and invalid model, thinking, and settings values", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    const id = created.conversation.id;
    const active = activeConversation(conversations, id);
    active.status = "running";

    await expect(conversations.setModel(id, "missing", "missing")).rejects.toMatchObject({ status: 409 });
    await expect(conversations.setThinking(id, "off")).rejects.toMatchObject({ status: 409 });
    await expect(conversations.compact(id)).rejects.toMatchObject({ status: 409 });
    await expect(conversations.branch(id, "entry", "edited")).rejects.toMatchObject({ status: 409 });
    await expect(conversations.delete(id)).rejects.toMatchObject({ status: 409 });

    active.status = "ready";
    await expect(conversations.setModel(id, "missing", "missing")).rejects.toMatchObject({ status: 404 });
    await expect(conversations.setThinking(id, "invalid" as never)).rejects.toMatchObject({ status: 400 });
    await expect(conversations.updateSettings(id, { autoRetry: "yes" } as never)).rejects.toMatchObject({ status: 400 });
    await expect(conversations.updateSettings(id, { queueOverrides: { steeringMode: "invalid" } } as never)).rejects.toMatchObject({ status: 400 });
    await expect(conversations.updateGlobalQueueSettings({ followUpMode: "invalid" } as never)).rejects.toMatchObject({ status: 400 });
    await conversations.shutdown();
  });

  it("validates image count, type, and size", async () => {
    const file = (name: string, type: string) => new NodeFile(["x"], name, { type }) as unknown as File;
    await expect(validateImages([file("a.png", "image/png")])).resolves.toMatchObject([{ type: "image", mimeType: "image/png" }]);
    expect(() => validateImages(Array.from({ length: 6 }, (_, index) => file(`${index}.png`, "image/png")))).toThrow(/最多/);
    await expect(validateImages([file("a.gif", "image/gif")])).rejects.toThrow(/仅支持/);
  });

  it("limits attachment count and size without restricting file types", () => {
    const file = (name: string, size: number) => ({ name, size }) as File;
    expect(() => validateAttachments([file("archive.zip", 1024), file("data.parquet", 2048)])).not.toThrow();
    expect(() => validateAttachments(Array.from({ length: 6 }, (_, index) => file(`${index}.bin`, 1)))).toThrow(/最多/);
    expect(() => validateAttachments([file("large.bin", 20 * 1024 * 1024 + 1)])).toThrow(/20 MB/);
  });

  it("stores arbitrary attachments in the workspace and adds their safe paths to the prompt", async () => {
    const conversations = await service();
    const created = await conversations.createConversation();
    const active = activeConversation(conversations, created.conversation.id);
    active.status = "running";
    const followUp = vi.spyOn(active.runtime.session, "followUp").mockResolvedValue(undefined);
    const file = new NodeFile(["alpha"], "../notes?.txt", { type: "text/plain" }) as unknown as File;

    await conversations.sendFiles(created.conversation.id, "分析附件", [file], "followUp");
    const [prompt, images] = followUp.mock.calls[0] as [string, unknown[]];
    const relativePath = prompt.match(/`(\.pi-chat-attachments\/[^`]+)`/)?.[1];
    expect(relativePath).toBeTruthy();
    expect(relativePath).not.toContain("..");
    expect(images).toEqual([]);
    expect(await readFile(join(created.conversation.workspace, relativePath!), "utf8")).toBe("alpha");
    active.status = "ready";
    await conversations.shutdown();
  });

  it("exports and imports an independent copy with message and tool history", async () => {
    const conversations = await service();
    const source = await conversations.createConversation();
    const active = activeConversation(conversations, source.conversation.id);
    active.runtime.session.setSessionName("Imported project");
    const manager = active.runtime.session.sessionManager;
    const timestamp = Date.now();
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the project" }], timestamp } as never);
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "I inspected it." },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: timestamp + 1,
    } as never);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "# Pi Chat Workspace" }],
      isError: false,
      timestamp: timestamp + 2,
    } as never);

    const exported = await conversations.export(source.conversation.id, "jsonl");
    await conversations.updateGlobalTool("web_search", false);
    const imported = await conversations.importConversation(new NodeFile([exported.content], "backup.jsonl", { type: "application/x-ndjson" }) as unknown as File);

    expect(imported.conversation).toMatchObject({ title: "Imported project" });
    expect(imported.conversation.id).not.toBe(source.conversation.id);
    expect(imported.conversation.workspace).not.toBe(source.conversation.workspace);
    expect(imported.messages.map((message) => message.text)).toEqual(["Inspect the project", "I inspected it."]);
    expect(imported.tools).toMatchObject([{ id: "tool-1", name: "read", status: "success", result: "# Pi Chat Workspace" }]);
    expect((await conversations.getToolSettings(imported.conversation.id)).tools.find((tool) => tool.name === "web_search")).toMatchObject({
      globalEnabled: false,
      conversationOverride: null,
      effectiveEnabled: false,
    });
    expect(await conversations.list()).toHaveLength(2);
    expect((await conversations.snapshot(source.conversation.id)).messages).toHaveLength(2);
    await conversations.shutdown();
  });

  it("rejects invalid and oversized imports without leaving partial data", async () => {
    const conversations = await service();
    const before = await managedFileCounts(conversations);
    const invalid = new NodeFile([
      `${JSON.stringify({ type: "session", version: 3, id: "source", timestamp: new Date().toISOString(), cwd: "/tmp/source" })}\nnot-json\n`,
    ], "broken.jsonl", { type: "application/x-ndjson" }) as unknown as File;

    await expect(conversations.importConversation(invalid)).rejects.toMatchObject({ status: 400 });
    expect(await managedFileCounts(conversations)).toEqual(before);

    const oversized = { name: "large.jsonl", size: MAX_IMPORT_BYTES + 1, text: vi.fn() } as unknown as File;
    await expect(conversations.importConversation(oversized)).rejects.toMatchObject({ status: 413 });
    expect(oversized.text).not.toHaveBeenCalled();
    expect(await managedFileCounts(conversations)).toEqual(before);
    await conversations.shutdown();
  });
});

function activeConversation(conversations: ConversationService, id: string) {
  const service = conversations as unknown as { active: Map<string, { status: "ready" | "running"; events: { activity(): Array<{ type: string; summary: string }>; publish(type: string, payload: unknown): void }; runtime: { session: {
    prompt(text: string, options: unknown): Promise<void>;
    steer(text: string, images: unknown[]): Promise<void>;
    followUp(text: string, images: unknown[]): Promise<void>;
    getActiveToolNames(): string[];
    setSessionName(name: string): void;
    sessionManager: { appendMessage(message: never): string; getSessionName(): string | undefined };
  } } }> };
  const active = service.active.get(id);
  if (!active) throw new Error("Expected an active conversation");
  return active;
}

async function managedFileCounts(conversations: ConversationService) {
  const { records, sessions, workspaces, exports } = conversations.paths;
  const counts = await Promise.all([records, sessions, workspaces, exports].map(async (path) => (await readdir(path)).length));
  return { records: counts[0], sessions: counts[1], workspaces: counts[2], exports: counts[3] };
}
