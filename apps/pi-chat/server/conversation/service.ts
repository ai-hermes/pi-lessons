import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  getSupportedThinkingLevels,
  type ImageContent,
  type TextContent,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { GlobalConfig } from "@server/config";
import { hasSameStringItems } from "@server/utils";
import type {
  ConversationConfig,
  ConversationConfigUpdate,
  ConversationSnapshot,
  ConversationSummary,
  ModelOption,
  RuntimeStatus,
  SkillOption,
} from "@shared/types";

import { EventChannel } from "./channel";
import { ConversationViewBuilder, extractImages, extractText, resultText } from "./helper";
import { ConversationRepository } from "./repository";
import { createRuntime } from "./runtime";
import type { ConversationRecord, ManagedSession } from "./types";

export class ConversationService {
  private globalConfig: GlobalConfig;
  private conversationRepository: ConversationRepository;
  private modelRuntime: ModelRuntime;
  readonly ttlMs: number = 30_000;
  private readonly channels = new Map<string, EventChannel>();
  private readonly managedSessions = new Map<string, ManagedSession>();

  constructor(globalConfig: GlobalConfig, modelRuntime: ModelRuntime) {
    this.globalConfig = globalConfig;
    this.modelRuntime = modelRuntime;
    this.conversationRepository = new ConversationRepository(globalConfig);
  }

  async createConversation() {
    const conversationId = randomUUID();
    const conversationWorkspaceDir = join(this.globalConfig.workspacesDir, conversationId);
    await mkdir(conversationWorkspaceDir, { recursive: true });

    const sessionManager = SessionManager.create(
      conversationWorkspaceDir,
      this.globalConfig.sessionsDir,
      {
        id: conversationId,
      },
    );

    const currentDate = new Date();
    const conversationRecord: ConversationRecord = {
      id: conversationId,
      title: "New Conversation",
      workspaceDir: conversationWorkspaceDir,
      sessionId: sessionManager.getSessionId(),
      sessionFile: sessionManager.getSessionFile()!,
      createdAt: currentDate,
      updatedAt: currentDate,
      selectedSkills: [],
    };
    await this.conversationRepository.save(conversationRecord);
    return this.createManagedSession(conversationRecord, sessionManager);
  }

  async send(conversationId: string, userInput: string, skills?: string[]) {
    const cleanedUserInput = userInput.trim();
    if (!cleanedUserInput || cleanedUserInput.length === 0) {
      throw new Error("User input cannot be empty.");
    }

    const loadSkillsResult = loadSkillsFromDir({
      dir: this.globalConfig.skillsDir,
      source: "project",
    });
    const availableSkillList = loadSkillsResult.skills.map((skill) => skill.name);
    const availableSkillsSet = new Set(availableSkillList);
    const validSelectedSkills = (skills ?? []).filter((skill) => availableSkillsSet.has(skill));

    const managedSession = await this.ensureManagedSession(conversationId, validSelectedSkills);
    const session = managedSession.runtime.session;
    session.prompt(cleanedUserInput);
  }

  public async snapshot(id: string): Promise<ConversationSnapshot> {
    const conversationRecord = await this.conversationRepository.get(id);
    if (!conversationRecord) {
      throw new Error(`Conversation with id ${id} not found.`);
    }
    const managedSession = await this.ensureManagedSession(id);
    const session = managedSession.runtime.session;
    const channel = managedSession.channel;

    const builder = new ConversationViewBuilder(session.sessionManager.getBranch());
    const messageList = builder.build();

    return {
      conversation: this.summary(conversationRecord, managedSession.status),
      messageList: messageList,
      activeSkillNames: [...managedSession.activeSkillNames],
      model: {
        provider: session.agent.state.model.provider,
        id: session.agent.state.model.id,
      },
      thinkingLevel: session.agent.state.thinkingLevel as ThinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
      status: managedSession.status,
      error: managedSession.error,
      stream: {
        id: channel.streamId,
        lastEventId: channel.lastId,
      },
      diagnostics: managedSession.diagnostics,
    };
  }

  async list(): Promise<ConversationSummary[]> {
    const conversationRecords = await this.conversationRepository.list();
    return conversationRecords
      .map((record) => this.summary(record, this.managedSessions.get(record.id)?.status ?? "cold"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string) {
    const conversationRecord = await this.conversationRepository.get(id);
    if (!conversationRecord) return;

    const managedSesson = this.managedSessions.get(id);
    if (managedSesson && this.isBusy(managedSesson)) {
      throw new Error(`Cannot delete conversation ${id} because it is busy.`);
    }

    if (existsSync(conversationRecord.sessionFile)) {
      await rm(conversationRecord.sessionFile, {
        force: true,
      });
    }

    await rm(conversationRecord.workspaceDir, {
      force: true,
      recursive: true,
    });
    await this.conversationRepository.delete(id);
  }

  public async rename(conversationId: string, title: string): Promise<ConversationSummary> {
    const cleanedTitle = title.trim();
    if (!cleanedTitle) throw Error("Title cannot be empty.");
    const newConversationRecord = await this.conversationRepository.update(conversationId, {
      title: cleanedTitle,
    });
    return this.summary(
      newConversationRecord,
      this.managedSessions.get(conversationId)?.status ?? "cold",
    );
  }

  public async abort(conversationId: string) {
    const managedSession = await this.ensureManagedSession(conversationId);
    if (!this.isBusy(managedSession)) return;
    this.setStatus(managedSession, "stopping");
    managedSession.runtime.session.abort();
    this.setStatus(managedSession, "ready");
  }

  async getConfig(conversationId: string): Promise<ConversationConfig> {
    const managedSession = await this.ensureManagedSession(conversationId);
    return this.config(managedSession);
  }

  getAvailableModels(): ModelOption[] {
    return this.modelOptions();
  }

  getAvailableSkills(): SkillOption[] {
    const loadSkillsResult = loadSkillsFromDir({
      dir: this.globalConfig.skillsDir,
      source: "project",
    });
    return loadSkillsResult.skills.map((skill) => {
      return {
        name: skill.name,
        description: skill.description,
      };
    });
  }

  async updateConfig(
    conversationId: string,
    update: ConversationConfigUpdate,
  ): Promise<ConversationConfig> {
    const managedSession = await this.ensureManagedSession(conversationId);
    if (this.isBusy(managedSession)) {
      throw new Error(
        `Cannot update config for conversation ${conversationId} because it is busy.`,
      );
    }

    const session = managedSession.runtime.session;
    if (update.model) {
      // session.setModel();
      const model = this.availableModels(managedSession).find(
        (item) => item.provider === update.model?.provider && item.id === update.model.id,
      );
      if (!model) {
        throw new Error(`Model ${update.model.provider}/${update.model.id} is not available.`);
      }
      await session.setModel(model);
    }

    if (update.thinkingLevel !== undefined) {
      if (!session.getAvailableThinkingLevels().includes(update.thinkingLevel as ThinkingLevel)) {
        throw new Error(`Thinking level ${update.thinkingLevel} is not available`);
      }
      session.setThinkingLevel(update.thinkingLevel);
    }

    return this.config(managedSession);
  }

  private config(managedSession: ManagedSession): ConversationConfig {
    const session = managedSession.runtime.session;
    return {
      model: {
        provider: session.agent.state.model.provider,
        id: session.agent.state.model.id,
      },
      models: this.modelOptions(managedSession),
      thinkingLevel: session.agent.state.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
    };
  }

  private modelOptions(managedSession?: ManagedSession): ModelOption[] {
    const models = managedSession
      ? this.availableModels(managedSession)
      : this.modelRuntime.getAvailableSnapshot();
    return models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      imageInput: model.input.includes("image"),
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
  }

  private availableModels(managedSession: ManagedSession) {
    const scopedModels = managedSession.runtime.session.scopedModels;
    return scopedModels.length > 0
      ? scopedModels.map((item) => item.model)
      : this.modelRuntime.getAvailableSnapshot();
  }

  private summary(record: ConversationRecord, status: RuntimeStatus): ConversationSummary {
    return {
      id: record.id,
      title: record.title,
      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      workspaceDir: record.workspaceDir,
      // ...(record.parentId ? { parentId: record.parentId } : {}),
      status,
    };
  }

  private async createManagedSession(
    conversationRecord: ConversationRecord,
    sessionManager: SessionManager,
    selectedSkills: string[] = [],
  ) {
    console.log("createManagedSession", selectedSkills);
    const runtime = await createRuntime({
      globalConfig: this.globalConfig,
      conversationRecord,
      sessionManager,
      modelRuntime: this.modelRuntime,
      selectedSkills,
    });

    const managedSession: ManagedSession = {
      id: conversationRecord.id,
      runtime,
      channel: this.getEventChannel(conversationRecord.id),
      status: runtime.session.isStreaming ? "running" : "ready",
      diagnostics: runtime.diagnostics.map((item) => item.message),
      activeSkillNames: [...selectedSkills],
    };
    this.managedSessions.set(managedSession.id, managedSession);
    this.bind(managedSession);
    return managedSession;
  }

  public getEventChannel(conversationId: string): EventChannel {
    let channel = this.channels.get(conversationId);
    if (!channel) {
      channel = new EventChannel();
      this.channels.set(conversationId, channel);
    }
    return channel;
  }

  private bind(managedSession: ManagedSession) {
    managedSession.unsubscribe?.();
    managedSession.unsubscribe = managedSession.runtime.session.subscribe((event) => {
      // Handle the event here
      switch (event.type) {
        case "agent_start":
          this.setStatus(managedSession, "running");
          break;
        case "message_start":
          const message = event.message;
          if (message.role === "assistant") {
            managedSession.streamMessageId = randomUUID();
            managedSession.streamThinkingId = undefined;
            managedSession.channel.publish("message.started", {
              id: managedSession.streamMessageId,
            });
          } else if (message.role === "user") {
            const content: (TextContent | ImageContent)[] =
              typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content;
            const text = extractText(content);
            const images = extractImages(content);
            managedSession.channel.publish("message.added", {
              id: randomUUID(),
              role: message.role,
              text,
              images,
              timestamp: message.timestamp,
            });
          }
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            managedSession.channel.publish("message.delta", {
              id: managedSession.streamMessageId,
              delta: event.assistantMessageEvent.delta,
              timestamp: event.message.timestamp,
            });
          } else if (event.assistantMessageEvent.type === "thinking_start") {
            managedSession.streamThinkingId = randomUUID();
            managedSession.channel.publish("thinking.started", {
              id: managedSession.streamThinkingId,
            });
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            managedSession.channel.publish("thinking.delta", {
              id: managedSession.streamThinkingId,
              delta: event.assistantMessageEvent.delta,
            });
          } else if (event.assistantMessageEvent.type === "thinking_end") {
            if (managedSession.streamThinkingId) {
              managedSession.channel.publish("thinking.completed", {
                id: managedSession.streamThinkingId,
              });
            }
          }
          break;
        case "entry_appended":
          break;
        case "tool_execution_start":
          managedSession.channel.publish("tool.started", {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
          });
          break;
        case "tool_execution_update":
          managedSession.channel.publish("tool.updated", {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            result: resultText(event.partialResult),
            details: event.partialResult, // todo
          });
          break;
        case "tool_execution_end":
          managedSession.channel.publish("tool.completed", {
            id: event.toolCallId,
            name: event.toolName,
            status: event.isError ? "error" : "success",
            result: resultText(event.result),
            details: event.result?.details,
          });
          break;
        case "agent_settled":
          managedSession.streamMessageId = undefined;
          managedSession.streamThinkingId = undefined;
          this.setStatus(managedSession, "ready");
          managedSession.channel.publish("runtime.settled", {});
          break;
        default:
          break;
      }
    });
  }

  private setStatus(managedSession: ManagedSession, status: RuntimeStatus) {
    managedSession.status = status;
    if (status !== "error") {
      managedSession.error = undefined;
    }
    managedSession.channel.publish("runtime.status", { status });
  }

  private async ensureManagedSession(conversationId: string, selectedSkills?: string[]) {
    let managedSession = this.managedSessions.get(conversationId);
    if (managedSession) {
      if (!selectedSkills || hasSameStringItems(managedSession.activeSkillNames, selectedSkills)) {
        return managedSession;
      }
      if (this.isBusy(managedSession)) {
        throw new Error(`Managed session is busy and cannot be updated with new selected skills.`);
      }
      // re-create managedsession

      const conversationRecord = await this.conversationRepository.get(conversationId);
      if (!conversationRecord) {
        throw new Error(`Conversation with ID ${conversationId} not found.`);
      }
      // pi sessionManager
      // eventChannel
      const sessionManager = managedSession.runtime.session.sessionManager;
      this.release(conversationId, { dropChannel: false });
      await this.conversationRepository.update(conversationId, { selectedSkills });
      return this.createManagedSession(conversationRecord, sessionManager, selectedSkills);
    }
    const conversationRecord = await this.conversationRepository.get(conversationId);
    if (!conversationRecord) {
      throw new Error(`Conversation with ID ${conversationId} not found.`);
    }
    const restoredSessionFile = conversationRecord?.sessionFile;
    let sessionManager: SessionManager;
    if (existsSync(restoredSessionFile)) {
      sessionManager = SessionManager.open(
        restoredSessionFile,
        this.globalConfig.sessionsDir,
        conversationRecord.workspaceDir,
      );
    } else {
      sessionManager = SessionManager.create(
        conversationRecord.workspaceDir,
        this.globalConfig.sessionsDir,
        {
          id: conversationId,
        },
      );
    }

    return this.createManagedSession(
      conversationRecord,
      sessionManager,
      conversationRecord.selectedSkills,
    );
  }

  private isBusy(managedSession: ManagedSession): boolean {
    return (
      managedSession.runtime.session.agent.state.isStreaming ||
      managedSession.status === "running" ||
      managedSession.status === "stopping" ||
      managedSession.status === "compacting"
    );
  }

  private async release(id: string, options: { dropChannel?: boolean } = {}) {
    const managedSession = this.managedSessions.get(id);
    if (!managedSession) return;
    managedSession.unsubscribe?.();
    managedSession.runtime.session.dispose();
    if (options.dropChannel ?? true) {
      this.channels.delete(id);
    }
    this.managedSessions.delete(id);
  }
}
