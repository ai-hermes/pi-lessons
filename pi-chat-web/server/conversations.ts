import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
  ActivityItem,
  BootstrapData,
  ChatImage,
  ConversationSettings,
  ConversationSettingsPatch,
  ConversationSnapshot,
  ConversationSummary,
  GlobalQueueSettings,
  GlobalToolSettingsView,
  QueueBehavior,
  QueueMode,
  RuntimeStatus,
  SessionStats,
  ThinkingLevel,
  ToolSettingItem,
  ToolSettingsView,
  ToolRun,
} from "@shared/types";
import { attachmentPrompt, safeAttachmentName, saveAttachments, validateAttachments, validateImages, visualAttachments } from "@server/attachments";
import { assertInside, ensurePaths, idleTtlMs, resolvePaths, SECURITY_WARNING, type AppPaths } from "@server/config";
import { ConversationError } from "@server/errors";
import { EventBuffer } from "@server/events";
import { projectEntry, projectTranscript } from "@server/projection";
import { readRepositoryInfo } from "@server/repository";
import { MAX_IMPORT_BYTES, validateSessionJsonl } from "@server/session-files";
import { PI_EXTENSION_PATHS } from "@server/pi-extensions";
import {
  type ConversationToolSettings,
  type GlobalToolSettings,
  ToolSettingsStore,
  conversationToolSettings,
} from "@server/tool-settings";

const SYSTEM_PROMPT = `You are Pi Chat, a helpful, precise coding assistant running in a dedicated conversation workspace.

You can inspect files, run commands, and edit the workspace. Explain important actions and summarize concrete results. Prefer small, verifiable changes. Never claim a command or edit succeeded unless its tool result confirms it.

The workspace is a convenience boundary, not an operating-system sandbox. Stay inside the current working directory unless the user explicitly asks otherwise. Do not expose credentials or secrets. Reply in the user's language.`;

interface ConversationRecord {
  id: string;
  title: string;
  workspace: string;
  sessionFile: string;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
  settings?: PersistedConversationSettings;
  toolSettings?: ConversationToolSettings;
}

interface PersistedConversationSettings {
  autoCompaction: boolean;
  autoRetry: boolean;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  steeringModeOverride?: QueueMode | null;
  followUpModeOverride?: QueueMode | null;
}

interface ActiveConversation {
  id: string;
  runtime: AgentSessionRuntime;
  events: EventBuffer;
  unsubscribe?: () => void;
  status: RuntimeStatus;
  error?: string;
  streamMessageId?: string;
  diagnostics: string[];
  timer?: ReturnType<typeof setTimeout>;
}

export class ConversationService {
  readonly paths: AppPaths;
  readonly ttlMs: number;
  private readonly active = new Map<string, ActiveConversation>();
  private readonly loading = new Map<string, Promise<ActiveConversation>>();
  private readonly channels = new Map<string, EventBuffer>();
  private readonly toolSettingsStore: ToolSettingsStore;

  private constructor(
    private readonly modelRuntime: ModelRuntime,
    paths: AppPaths,
    ttl: number,
  ) {
    this.paths = paths;
    this.ttlMs = ttl;
    this.toolSettingsStore = new ToolSettingsStore(paths.appSettings);
  }

  static async create(options: { dataDir?: string; ttlMs?: number; modelRuntime?: ModelRuntime } = {}): Promise<ConversationService> {
    const paths = resolvePaths(options.dataDir);
    await ensurePaths(paths);
    const ownsModelRuntime = options.modelRuntime === undefined;
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create();
    if (ownsModelRuntime) await loadConfiguredProviderExtensions(modelRuntime, paths.root);
    return new ConversationService(modelRuntime, paths, options.ttlMs ?? idleTtlMs());
  }

  async bootstrap(): Promise<BootstrapData> {
    const models = (await this.modelRuntime.getAvailable()).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      imageInput: model.input.includes("image"),
    }));
    return { models, warning: SECURITY_WARNING, idleTtlMs: this.ttlMs, dataDir: this.paths.root, repository: await readRepositoryInfo() };
  }

  async list(): Promise<ConversationSummary[]> {
    const records = await this.readRecords();
    return records
      .map((record) => this.summary(record, this.active.get(record.id)?.status ?? "cold"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createConversation(): Promise<ConversationSnapshot> {
    const id = randomUUID();
    const workspace = assertInside(this.paths.workspaces, join(this.paths.workspaces, id));
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Pi Chat Workspace\n\nThis directory belongs to one Pi Chat conversation family.\n", "utf8");
    const manager = SessionManager.create(workspace, this.paths.sessions, { id });
    const now = new Date().toISOString();
    const record: ConversationRecord = {
      id,
      title: "新对话",
      workspace,
      sessionFile: manager.getSessionFile()!,
      createdAt: now,
      updatedAt: now,
      settings: defaultPersistedSettings(),
      toolSettings: { overrides: {} },
    };
    await this.writeRecord(record);
    await this.load(record, manager);
    return this.snapshot(id);
  }

  async importConversation(file: File): Promise<ConversationSnapshot> {
    if (!file.name || file.size === 0) throw new ConversationError("请选择非空的 Pi Session JSONL 文件。");
    if (file.size > MAX_IMPORT_BYTES) throw new ConversationError("会话文件不能超过 20 MB。", 413);

    const content = validateSessionJsonl(await file.text());
    const id = randomUUID();
    const workspace = assertInside(this.paths.workspaces, join(this.paths.workspaces, id));
    const temporaryPath = assertInside(this.paths.exports, join(this.paths.exports, `import-${id}.jsonl`));
    let sessionFile: string | undefined;

    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "README.md"), "# Pi Chat Workspace\n\nThis directory belongs to one imported Pi Chat conversation.\n", "utf8");
      await writeFile(temporaryPath, content, "utf8");

      let manager: SessionManager;
      try {
        manager = SessionManager.forkFrom(temporaryPath, workspace, this.paths.sessions, { id });
      } catch {
        throw new ConversationError("无法读取此 Pi Session，文件可能已损坏或版本不兼容。");
      }

      sessionFile = manager.getSessionFile();
      if (!sessionFile) throw new ConversationError("导入的会话未生成 Session 文件。");
      const now = new Date().toISOString();
      const importedName = manager.getSessionName()?.trim();
      const fallbackName = basename(file.name).replace(/\.jsonl$/i, "").trim() || "导入的会话";
      const record: ConversationRecord = {
        id,
        title: (importedName || `${fallbackName}（导入）`).slice(0, 120),
        workspace,
        sessionFile,
        createdAt: now,
        updatedAt: now,
        settings: defaultPersistedSettings(),
        toolSettings: { overrides: {} },
      };
      await this.writeRecord(record);
      await this.load(record, manager);
      return await this.snapshot(id);
    } catch (error) {
      await this.release(id).catch(() => undefined);
      this.channels.delete(id);
      await Promise.allSettled([
        rm(this.recordPath(id), { force: true }),
        ...(sessionFile ? [rm(assertInside(this.paths.sessions, sessionFile), { force: true })] : []),
        rm(workspace, { recursive: true, force: true }),
      ]);
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async snapshot(id: string): Promise<ConversationSnapshot> {
    const record = await this.getRecord(id);
    const active = await this.ensureRuntime(id);
    this.touch(active);
    const session = active.runtime.session;
    const projected = projectTranscript(session.sessionManager.getBranch());
    const stats = normalizeStats(session.getSessionStats());
    const queue = { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] };
    const channel = active.events;

    return {
      conversation: { ...this.summary(record, active.status), messageCount: projected.messages.length },
      messages: projected.messages,
      tools: projected.tools,
      thinking: projected.thinking,
      model: { provider: session.agent.state.model.provider, id: session.agent.state.model.id },
      thinkingLevel: session.agent.state.thinkingLevel as ThinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
      status: active.status,
      ...(active.error ? { error: active.error } : {}),
      queue,
      settings: await this.settings(session, record),
      stats,
      stream: { id: channel.streamId, lastEventId: channel.lastId },
      activity: mergeActivity(channel.activity(), projected.activity),
      diagnostics: active.diagnostics,
    };
  }

  async rename(id: string, title: string): Promise<ConversationSummary> {
    const clean = title.trim().slice(0, 120);
    if (!clean) throw new ConversationError("标题不能为空。");
    const active = await this.ensureRuntime(id);
    active.runtime.session.setSessionName(clean);
    const record = await this.updateRecord(id, (current) => {
      current.title = clean;
      current.updatedAt = new Date().toISOString();
    });
    active.events.publish("conversation.renamed", { title: clean });
    this.touch(active);
    return this.summary(record, active.status);
  }

  async delete(id: string): Promise<void> {
    const record = await this.getRecord(id);
    const active = this.active.get(id);
    if (active && this.isBusy(active)) throw new ConversationError("运行期间不能删除对话。", 409);
    await this.release(id);
    await rm(assertInside(this.paths.records, this.recordPath(id)), { force: true });
    if (existsSync(record.sessionFile)) await rm(assertInside(this.paths.sessions, record.sessionFile), { force: true });

    const remaining = await this.readRecords();
    if (!remaining.some((item) => item.workspace === record.workspace)) {
      await rm(assertInside(this.paths.workspaces, record.workspace), { recursive: true, force: true });
    }
    this.channels.delete(id);
  }

  async sendFiles(id: string, text: string, files: File[], behavior: QueueBehavior): Promise<void> {
    validateAttachments(files);
    const active = await this.ensureRuntime(id);
    const record = await this.getRecord(id);
    const supportsImages = active.runtime.session.agent.state.model.input.includes("image");
    const images = await validateImages(visualAttachments(files, supportsImages));
    const attachments = await saveAttachments(record.workspace, files);
    const prompt = attachmentPrompt(text, attachments);
    const title = text.trim() || (files[0] ? `分析 ${safeAttachmentName(files[0].name)}` : "");
    await this.send(id, prompt, images, behavior, title);
  }

  async send(id: string, text: string, images: ChatImage[], behavior: QueueBehavior, titleText = text): Promise<void> {
    const clean = text.trim();
    if (!clean && images.length === 0) throw new ConversationError("请输入消息或添加图片。");
    if (clean.length > 20_000) throw new ConversationError("消息不能超过 20,000 个字符。");
    const active = await this.ensureRuntime(id);
    const session = active.runtime.session;
    active.error = undefined;

    if (active.status === "stopping" || active.status === "compacting") {
      throw new ConversationError("停止或压缩期间不能发送消息。", 409);
    }

    if (session.agent.state.isStreaming || active.status === "running") {
      if (behavior === "steer") await session.steer(clean, images);
      else await session.followUp(clean, images);
      this.touch(active);
      return;
    }

    let generatedTitle: string | undefined;
    await this.updateRecord(id, (record) => {
      if (record.title === "新对话") {
        const title = conversationTitle(titleText);
        if (title) {
          record.title = title;
          session.setSessionName(title);
          generatedTitle = title;
        }
      }
      record.updatedAt = new Date().toISOString();
    });
    if (generatedTitle) active.events.publish("conversation.renamed", { title: generatedTitle });
    this.setStatus(active, "running");

    session.prompt(clean || "请分析附带的图片。", {
      images,
      preflightResult: (accepted) => {
        if (!accepted) this.fail(active, new Error("消息未被 Agent 接受。"));
      },
    }).catch((error: unknown) => this.fail(active, error));
  }

  async abort(id: string): Promise<void> {
    const active = await this.ensureRuntime(id);
    if (!this.isBusy(active)) return;
    this.setStatus(active, "stopping");
    await active.runtime.session.abort();
    this.setStatus(active, "ready");
    this.touch(active);
  }

  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    const active = await this.ensureIdle(id);
    const available = await this.modelRuntime.getAvailable(provider);
    const model = available.find((item) => item.id === modelId);
    if (!model) throw new ConversationError("模型不可用或尚未配置凭证。", 404);
    await active.runtime.session.setModel(model);
    active.events.publish("model.changed", { provider, id: modelId });
    this.touch(active);
  }

  async setThinking(id: string, level: ThinkingLevel): Promise<void> {
    const active = await this.ensureIdle(id);
    const levels = active.runtime.session.getAvailableThinkingLevels();
    if (!levels.includes(level)) throw new ConversationError("当前模型不支持该思考级别。");
    active.runtime.session.setThinkingLevel(level);
    active.events.publish("thinking.changed", { level });
    this.touch(active);
  }

  async compact(id: string, instructions?: string): Promise<void> {
    const active = await this.ensureIdle(id);
    this.setStatus(active, "compacting");
    active.runtime.session.compact(instructions?.trim() || undefined)
      .then(() => this.setStatus(active, "ready"))
      .catch((error: unknown) => this.fail(active, error));
  }

  async updateSettings(id: string, patch: ConversationSettingsPatch): Promise<ConversationSettings> {
    if (patch.autoCompaction !== undefined && typeof patch.autoCompaction !== "boolean") throw new ConversationError("autoCompaction 必须是布尔值。");
    if (patch.autoRetry !== undefined && typeof patch.autoRetry !== "boolean") throw new ConversationError("autoRetry 必须是布尔值。");
    validateQueueOverride(patch.queueOverrides?.steeringMode, "steeringMode");
    validateQueueOverride(patch.queueOverrides?.followUpMode, "followUpMode");
    const active = await this.ensureRuntime(id);
    const session = active.runtime.session;
    if (patch.autoCompaction !== undefined) session.setAutoCompactionEnabled(patch.autoCompaction);
    if (patch.autoRetry !== undefined) session.setAutoRetryEnabled(patch.autoRetry);
    const record = await this.updateRecord(id, (current) => {
      const settings = persistedSettings(current.settings);
      if (patch.autoCompaction !== undefined) settings.autoCompaction = patch.autoCompaction;
      if (patch.autoRetry !== undefined) settings.autoRetry = patch.autoRetry;
      if (patch.queueOverrides?.steeringMode !== undefined) settings.steeringModeOverride = patch.queueOverrides.steeringMode;
      if (patch.queueOverrides?.followUpMode !== undefined) settings.followUpModeOverride = patch.queueOverrides.followUpMode;
      current.settings = settings;
      current.updatedAt = new Date().toISOString();
    });
    const global = await this.toolSettingsStore.read();
    const overrides = queueOverrides(record.settings);
    session.setSteeringMode(overrides.steeringMode ?? global.steeringMode);
    session.setFollowUpMode(overrides.followUpMode ?? global.followUpMode);
    const settings = await this.settings(session, record, global);
    active.events.publish("settings.changed", settings);
    this.touch(active);
    return settings;
  }

  async getToolSettings(id: string): Promise<ToolSettingsView> {
    const [record, active, global] = await Promise.all([
      this.getRecord(id),
      this.ensureRuntime(id),
      this.toolSettingsStore.read(),
    ]);
    return toolSettingsView(active.runtime.session, record.toolSettings, global);
  }

  async getGlobalToolSettings(): Promise<GlobalToolSettingsView> {
    const context = await this.globalToolSettingsContext();
    return globalToolSettingsView(context.runtime.session, await this.toolSettingsStore.read());
  }

  async getGlobalQueueSettings(): Promise<GlobalQueueSettings> {
    return globalQueueSettings(await this.toolSettingsStore.read());
  }

  async updateGlobalQueueSettings(patch: Partial<GlobalQueueSettings>): Promise<GlobalQueueSettings> {
    validateQueueMode(patch.steeringMode, "steeringMode");
    validateQueueMode(patch.followUpMode, "followUpMode");
    const global = await this.toolSettingsStore.updateQueue(patch);
    await Promise.all([...this.active.values()].map(async (active) => {
      const record = await this.getRecord(active.id);
      const overrides = queueOverrides(record.settings);
      active.runtime.session.setSteeringMode(overrides.steeringMode ?? global.steeringMode);
      active.runtime.session.setFollowUpMode(overrides.followUpMode ?? global.followUpMode);
      active.events.publish("settings.changed", await this.settings(active.runtime.session, record, global));
      this.touch(active);
    }));
    return globalQueueSettings(global);
  }

  async updateGlobalTool(name: string, enabled: boolean): Promise<GlobalToolSettingsView> {
    if (typeof name !== "string" || !name.trim()) throw new ConversationError("工具名称无效。");
    if (typeof enabled !== "boolean") throw new ConversationError("enabled 必须是布尔值。");
    const context = await this.globalToolSettingsContext();
    assertRegisteredTool(context.runtime.session, name);

    const global = await this.toolSettingsStore.update(name, enabled);
    await Promise.all([...this.active.values()].map(async (active) => {
      const record = await this.getRecord(active.id);
      applyToolSettings(active.runtime.session, record.toolSettings, global);
      active.events.publish("tools.changed", {});
      this.touch(active);
    }));

    return globalToolSettingsView(context.runtime.session, global);
  }

  async updateConversationTool(id: string, name: string, enabled: boolean | null): Promise<ToolSettingsView> {
    if (typeof name !== "string" || !name.trim()) throw new ConversationError("工具名称无效。");
    if (enabled !== null && typeof enabled !== "boolean") throw new ConversationError("enabled 必须是布尔值或 null。");
    const active = await this.ensureRuntime(id);
    assertRegisteredTool(active.runtime.session, name);
    const record = await this.updateRecord(id, (current) => {
      const settings = conversationToolSettings(current.toolSettings);
      if (enabled === null) delete settings.overrides[name];
      else settings.overrides[name] = enabled;
      current.toolSettings = settings;
      current.updatedAt = new Date().toISOString();
    });
    const global = await this.toolSettingsStore.read();
    applyToolSettings(active.runtime.session, record.toolSettings, global);
    active.events.publish("tools.changed", {});
    this.touch(active);
    return toolSettingsView(active.runtime.session, record.toolSettings, global);
  }

  async branch(id: string, entryId: string, text: string): Promise<ConversationSnapshot> {
    const active = await this.ensureIdle(id);
    const source = await this.getRecord(id);
    active.unsubscribe?.();
    const result = await active.runtime.fork(entryId, { position: "before" });
    if (result.cancelled) throw new ConversationError("分支操作已取消。", 409);

    const newId = active.runtime.session.sessionManager.getSessionId();
    const title = `${source.title} · 分支`;
    active.runtime.session.setSessionName(title);
    const record: ConversationRecord = {
      id: newId,
      title,
      workspace: source.workspace,
      sessionFile: active.runtime.session.sessionFile!,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      parentId: id,
      settings: structuredClone(persistedSettings(source.settings)),
      toolSettings: structuredClone(conversationToolSettings(source.toolSettings)),
    };
    await this.writeRecord(record);
    this.active.delete(id);
    active.id = newId;
    active.events = this.channel(newId);
    active.status = "ready";
    this.active.set(newId, active);
    await this.bind(active);
    this.touch(active);
    await this.send(newId, text.trim() || result.selectedText || "继续。", [], "followUp");
    return this.snapshot(newId);
  }

  async export(id: string, format: "jsonl" | "html"): Promise<{ path: string; content: string; contentType: string }> {
    const active = await this.ensureIdle(id);
    if (format === "jsonl") {
      const path = active.runtime.session.sessionFile;
      if (!path || !existsSync(path)) throw new ConversationError("当前会话尚未产生可导出的内容。", 404);
      return { path, content: await readFile(path, "utf8"), contentType: "application/x-ndjson; charset=utf-8" };
    }
    const path = assertInside(this.paths.exports, join(this.paths.exports, `${id}.html`));
    await active.runtime.session.exportToHtml(path);
    return { path, content: await readFile(path, "utf8"), contentType: "text/html; charset=utf-8" };
  }

  async eventStream(id: string, streamId: string | undefined, after: number): Promise<Response> {
    await this.getRecord(id);
    const events = this.channel(id);
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        const replay = events.replay(after);
        if ((streamId && streamId !== events.streamId) || replay.stale) {
          send(events.publish("snapshot.required", {}));
        } else {
          for (const event of replay.events) send(event);
        }
        unsubscribe = events.subscribe(send);
        heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
      },
      cancel: () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
      },
    });
    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  async release(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.unsubscribe?.();
    await active.runtime.dispose();
    this.active.delete(id);
  }

  async releaseIdle(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    if (this.isBusy(active)) {
      this.touch(active);
      return;
    }
    active.events.publish("runtime.status", { status: "cold" });
    await this.release(id);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.release(id)));
  }

  private async ensureIdle(id: string): Promise<ActiveConversation> {
    const active = await this.ensureRuntime(id);
    if (this.isBusy(active)) throw new ConversationError("Agent 正在运行，请先停止或等待完成。", 409);
    return active;
  }

  private async globalToolSettingsContext(): Promise<ActiveConversation> {
    const active = this.active.values().next().value as ActiveConversation | undefined;
    if (active) return active;
    const record = (await this.readRecords())[0];
    if (!record) throw new ConversationError("请先创建一个会话。", 409);
    return this.ensureRuntime(record.id);
  }

  private isBusy(active: ActiveConversation): boolean {
    return active.runtime.session.agent.state.isStreaming || active.status === "running" || active.status === "stopping" || active.status === "compacting";
  }

  private async ensureRuntime(id: string): Promise<ActiveConversation> {
    const current = this.active.get(id);
    if (current) return current;
    const pending = this.loading.get(id);
    if (pending) return pending;
    const load = this.getRecord(id).then((record) => this.load(record)).finally(() => this.loading.delete(id));
    this.loading.set(id, load);
    return load;
  }

  private async load(record: ConversationRecord, manager?: SessionManager): Promise<ActiveConversation> {
    const restoredSessionFile = manager ? undefined : await this.findSessionFile(record);
    const sessionManager = manager ?? (restoredSessionFile
      ? SessionManager.open(restoredSessionFile, this.paths.sessions, record.workspace)
      : SessionManager.create(record.workspace, this.paths.sessions, { id: record.id }));
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager: nextManager, sessionStartEvent }) => {
      const global = await this.toolSettingsStore.read();
      const overrides = queueOverrides(record.settings);
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: record.settings?.autoCompaction ?? true },
        retry: { enabled: record.settings?.autoRetry ?? true, maxRetries: 2 },
        steeringMode: overrides.steeringMode ?? global.steeringMode,
        followUpMode: overrides.followUpMode ?? global.followUpMode,
      });
      const services = await createAgentSessionServices({
        cwd,
        agentDir: getAgentDir(),
        settingsManager,
        modelRuntime: this.modelRuntime,
        resourceLoaderOptions: {
          noExtensions: true,
          additionalExtensionPaths: PI_EXTENSION_PATHS,
          systemPromptOverride: () => SYSTEM_PROMPT,
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: nextManager,
        sessionStartEvent,
      });
      applyToolSettings(created.session, record.toolSettings, await this.toolSettingsStore.read());
      return {
        ...created,
        services,
        diagnostics: services.diagnostics,
      };
    };
    const runtime = await createAgentSessionRuntime(factory, {
      cwd: record.workspace,
      agentDir: getAgentDir(),
      sessionManager,
    });
    const sessionFile = runtime.session.sessionFile;
    if (sessionFile && sessionFile !== record.sessionFile) {
      await this.updateRecord(record.id, (current) => {
        current.sessionFile = sessionFile;
      });
    }
    if (runtime.session.sessionManager.getSessionName() !== record.title) runtime.session.setSessionName(record.title);
    const active: ActiveConversation = {
      id: record.id,
      runtime,
      events: this.channel(record.id),
      status: runtime.session.agent.state.isStreaming ? "running" : "ready",
      diagnostics: runtime.diagnostics.map((item) => item.message),
    };
    this.active.set(record.id, active);
    await this.bind(active);
    this.touch(active);
    return active;
  }

  private async findSessionFile(record: ConversationRecord): Promise<string | undefined> {
    if (existsSync(record.sessionFile)) return record.sessionFile;

    const suffix = `_${record.id}.jsonl`;
    const candidates = (await readdir(this.paths.sessions))
      .filter((file) => file.endsWith(suffix))
      .sort();
    return candidates.at(-1) ? assertInside(this.paths.sessions, join(this.paths.sessions, candidates.at(-1)!)) : undefined;
  }

  private async bind(active: ActiveConversation): Promise<void> {
    active.unsubscribe?.();
    await active.runtime.session.bindExtensions({});
    active.unsubscribe = active.runtime.session.subscribe((event) => this.onEvent(active, event));
  }

  private onEvent(active: ActiveConversation, event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.setStatus(active, "running");
        break;
      case "message_start": {
        const message = event.message as { role?: string; timestamp?: number };
        if (message.role === "assistant") {
          active.streamMessageId = `stream_${message.timestamp ?? Date.now()}`;
          active.events.publish("message.started", { id: active.streamMessageId, timestamp: message.timestamp ?? Date.now() });
        } else if (message.role === "user") {
          // Queued steer/follow-up messages are persisted via message_end without an
          // entry_appended event, so surface them here at delivery time.
          const projected = projectTranscript([{
            type: "message",
            id: `delivered_${message.timestamp ?? Date.now()}`,
            timestamp: new Date().toISOString(),
            message: event.message,
          }]).messages[0];
          if (projected) active.events.publish("message.added", { message: projected });
        }
        break;
      }
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          active.events.publish("message.delta", { id: active.streamMessageId, delta: event.assistantMessageEvent.delta });
        }
        break;
      case "entry_appended": {
        const message = projectEntry(event.entry);
        if (message?.role === "user") active.events.publish("message.added", { message });
        else if (message?.role === "assistant") active.events.publish("message.completed", { streamId: active.streamMessageId, message });
        break;
      }
      case "tool_execution_start":
        active.events.publish("tool.started", { id: event.toolCallId, name: event.toolName, args: event.args, startedAt: Date.now() });
        break;
      case "tool_execution_update":
        active.events.publish("tool.updated", { id: event.toolCallId, name: event.toolName, result: resultText(event.partialResult), details: event.partialResult?.details });
        break;
      case "tool_execution_end":
        active.events.publish("tool.completed", {
          id: event.toolCallId,
          name: event.toolName,
          status: event.isError ? "error" : "success",
          result: resultText(event.result),
          details: event.result?.details,
          endedAt: Date.now(),
        });
        break;
      case "queue_update":
        active.events.publish("queue.updated", { steering: event.steering, followUp: event.followUp });
        break;
      case "compaction_start":
        this.setStatus(active, "compacting");
        active.events.publish("compaction.started", { reason: event.reason });
        break;
      case "compaction_end":
        active.events.publish("compaction.completed", { reason: event.reason, aborted: event.aborted, error: event.errorMessage });
        if (!event.willRetry) this.setStatus(active, event.errorMessage ? "error" : "ready");
        break;
      case "auto_retry_start":
        active.events.publish("retry.started", { attempt: event.attempt, maxAttempts: event.maxAttempts, error: event.errorMessage });
        break;
      case "auto_retry_end":
        active.events.publish("retry.completed", { success: event.success, attempt: event.attempt, error: event.finalError });
        break;
      case "thinking_level_changed":
        active.events.publish("thinking.changed", { level: event.level });
        break;
      case "agent_settled":
        active.streamMessageId = undefined;
        this.setStatus(active, "ready");
        active.events.publish("runtime.settled", {});
        this.updateRecord(active.id, (record) => {
          record.sessionFile = active.runtime.session.sessionFile ?? record.sessionFile;
          record.updatedAt = new Date().toISOString();
        }).catch((error: unknown) => this.fail(active, error));
        this.touch(active);
        break;
      default:
        break;
    }
  }

  private setStatus(active: ActiveConversation, status: RuntimeStatus): void {
    active.status = status;
    if (status !== "error") active.error = undefined;
    active.events.publish("runtime.status", { status });
  }

  private fail(active: ActiveConversation, error: unknown): void {
    active.status = "error";
    active.error = error instanceof Error ? error.message : String(error);
    active.events.publish("runtime.error", { error: active.error });
    this.touch(active);
  }

  private touch(active: ActiveConversation): void {
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      this.releaseIdle(active.id).catch((error: unknown) => this.fail(active, error));
    }, this.ttlMs);
    active.timer.unref?.();
  }

  private async settings(
    session: ActiveConversation["runtime"]["session"],
    record: ConversationRecord,
    global?: GlobalToolSettings,
  ): Promise<ConversationSettings> {
    const defaults = global ?? await this.toolSettingsStore.read();
    const overrides = queueOverrides(record.settings);
    return {
      autoCompaction: session.autoCompactionEnabled,
      autoRetry: session.autoRetryEnabled,
      steeringMode: session.settingsManager.getSteeringMode(),
      followUpMode: session.settingsManager.getFollowUpMode(),
      queueDefaults: globalQueueSettings(defaults),
      queueOverrides: overrides,
    };
  }

  private channel(id: string): EventBuffer {
    let channel = this.channels.get(id);
    if (!channel) {
      channel = new EventBuffer();
      this.channels.set(id, channel);
    }
    return channel;
  }

  private summary(record: ConversationRecord, status: RuntimeStatus): ConversationSummary {
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: 0,
      workspace: record.workspace,
      ...(record.parentId ? { parentId: record.parentId } : {}),
      status,
    };
  }

  private recordPath(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ConversationError("无效的对话 ID。", 400);
    return join(this.paths.records, `${id}.json`);
  }

  private async getRecord(id: string): Promise<ConversationRecord> {
    try {
      return JSON.parse(await readFile(this.recordPath(id), "utf8")) as ConversationRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConversationError("对话不存在。", 404);
      throw error;
    }
  }

  private async readRecords(): Promise<ConversationRecord[]> {
    const files = (await readdir(this.paths.records)).filter((file) => file.endsWith(".json"));
    const records = await Promise.all(files.map(async (file) => {
      try { return JSON.parse(await readFile(join(this.paths.records, file), "utf8")) as ConversationRecord; }
      catch { return undefined; }
    }));
    return records.filter((record): record is ConversationRecord => Boolean(record));
  }

  private async writeRecord(record: ConversationRecord): Promise<void> {
    const path = assertInside(this.paths.records, this.recordPath(record.id));
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private async updateRecord(id: string, update: (record: ConversationRecord) => void): Promise<ConversationRecord> {
    const record = await this.getRecord(id);
    update(record);
    await this.writeRecord(record);
    return record;
  }

}

function conversationTitle(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function mergeActivity(live: ActivityItem[], history: ActivityItem[]): ActivityItem[] {
  const historyKeys = new Set(history.flatMap((item) => item.sourceId ? [`${item.type}:${item.sourceId}`] : []));
  return [...live.filter((item) => !item.sourceId || !historyKeys.has(`${item.type}:${item.sourceId}`)), ...history].slice(0, 100);
}

async function loadConfiguredProviderExtensions(modelRuntime: ModelRuntime, cwd: string): Promise<void> {
  const agentDir = getAgentDir();
  try {
    await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.create(cwd, agentDir),
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
  } catch (error) {
    console.warn("Unable to load configured Pi provider extensions; using built-in providers only.", error);
  }
}

function resultText(result: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  return result?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}

function normalizeStats(stats: ReturnType<ActiveConversation["runtime"]["session"]["getSessionStats"]>): SessionStats {
  const context = stats.contextUsage;
  return {
    sessionId: stats.sessionId,
    userMessages: stats.userMessages,
    assistantMessages: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    totalMessages: stats.totalMessages,
    tokens: stats.tokens,
    cost: stats.cost,
    ...(context ? { contextUsage: { tokens: context.tokens ?? 0, contextWindow: context.contextWindow, percent: context.percent ?? 0 } } : {}),
  };
}

function applyToolSettings(
  session: AgentSession,
  conversation: ConversationToolSettings | undefined,
  global: GlobalToolSettings,
): void {
  const overrides = conversationToolSettings(conversation).overrides;
  session.setActiveToolsByName(
    session.getAllTools()
      .filter((tool) => overrides[tool.name] ?? global.overrides[tool.name] ?? global.defaultEnabled)
      .map((tool) => tool.name),
  );
}

function toolSettingsView(
  session: AgentSession,
  conversation: ConversationToolSettings | undefined,
  global: GlobalToolSettings,
): ToolSettingsView {
  const overrides = conversationToolSettings(conversation).overrides;
  return {
    defaultEnabled: true,
    tools: session.getAllTools()
      .map((tool): ToolSettingItem => {
        const globalEnabled = global.overrides[tool.name] ?? global.defaultEnabled;
        const conversationOverride = overrides[tool.name] ?? null;
        return {
          name: tool.name,
          description: tool.description,
          source: toolSource(tool.sourceInfo),
          globalEnabled,
          conversationOverride,
          effectiveEnabled: conversationOverride ?? globalEnabled,
        };
      })
      .sort((left, right) => left.source.label.localeCompare(right.source.label) || left.name.localeCompare(right.name)),
  };
}

function globalToolSettingsView(session: AgentSession, global: GlobalToolSettings): GlobalToolSettingsView {
  return {
    defaultEnabled: true,
    tools: session.getAllTools()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        source: toolSource(tool.sourceInfo),
        enabled: global.overrides[tool.name] ?? global.defaultEnabled,
      }))
      .sort((left, right) => left.source.label.localeCompare(right.source.label) || left.name.localeCompare(right.name)),
  };
}

function assertRegisteredTool(session: AgentSession, name: string): void {
  if (!session.getAllTools().some((tool) => tool.name === name)) {
    throw new ConversationError(`工具不存在或尚未注册：${name}`, 404);
  }
}

function toolSource(sourceInfo: { source: string; path: string }): ToolSettingItem["source"] {
  if (sourceInfo.source === "builtin" || sourceInfo.path.startsWith("<builtin:")) {
    return { kind: "builtin", label: "内置工具" };
  }
  return {
    kind: "extension",
    label: packageNameFromPath(sourceInfo.path) ?? sourceInfo.source ?? "Extension",
    path: sourceInfo.path,
  };
}

function packageNameFromPath(path: string): string | undefined {
  const marker = `${path.includes("\\") ? "\\" : "/"}node_modules${path.includes("\\") ? "\\" : "/"}`;
  const tail = path.split(marker).at(-1);
  if (!tail || tail === path) return undefined;
  const parts = tail.split(/[\\/]/);
  return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function defaultPersistedSettings(): PersistedConversationSettings {
  return { autoCompaction: true, autoRetry: true, steeringModeOverride: null, followUpModeOverride: null };
}

function persistedSettings(value: PersistedConversationSettings | undefined): PersistedConversationSettings {
  return {
    autoCompaction: value?.autoCompaction ?? true,
    autoRetry: value?.autoRetry ?? true,
    steeringModeOverride: value?.steeringModeOverride ?? value?.steeringMode ?? null,
    followUpModeOverride: value?.followUpModeOverride ?? value?.followUpMode ?? null,
  };
}

function queueOverrides(value: PersistedConversationSettings | undefined): NonNullable<ConversationSettings["queueOverrides"]> {
  const settings = persistedSettings(value);
  return {
    steeringMode: settings.steeringModeOverride ?? null,
    followUpMode: settings.followUpModeOverride ?? null,
  };
}

function globalQueueSettings(settings: GlobalToolSettings): GlobalQueueSettings {
  return { steeringMode: settings.steeringMode, followUpMode: settings.followUpMode };
}

function validateQueueMode(value: unknown, name: string): void {
  if (value !== undefined && value !== "all" && value !== "one-at-a-time") throw new ConversationError(`${name} 无效。`);
}

function validateQueueOverride(value: unknown, name: string): void {
  if (value !== undefined && value !== null && value !== "all" && value !== "one-at-a-time") throw new ConversationError(`${name} 无效。`);
}
