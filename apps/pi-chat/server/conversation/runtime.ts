import {
  createAgentSessionRuntime,
  getAgentDir,
  SessionManager,
  createAgentSessionServices,
  ModelRuntime,
  createAgentSessionFromServices,
  type CreateAgentSessionRuntimeFactory,
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { GlobalConfig } from "@server/config";

import type { ConversationRecord } from "./types";
import { Type } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export interface RuntimeOptions {
  conversationRecord: ConversationRecord;
  globalConfig: GlobalConfig;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
}

const SYSTEM_PROMPT = `You are Pi Chat, a helpful, precise coding assistant running in a dedicated conversation workspace.

You can inspect files, run commands, and edit the workspace. Explain important actions and summarize concrete results. Prefer small, verifiable changes. Never claim a command or edit succeeded unless its tool result confirms it.

The workspace is a convenience boundary, not an operating-system sandbox. Stay inside the current working directory unless the user explicitly asks otherwise. Do not expose credentials or secrets. Reply in the user's language.`;


const utcTimeTool = defineTool({
    name: 'utc_time',
    label: 'utc_time',
    description: 'return the current UTC ISO timestamp',
    parameters: Type.Object({}),
    execute: async () => {
        return {
            content: [
                {
                    type: 'text',
                    text: new Date().toISOString(),
                }
            ],
            details: {},
        };
    }
})

const webAccessExtensionPath = dirname(
  createRequire(import.meta.url).resolve("pi-web-access/package.json"),
);

export async function createRuntime(options: RuntimeOptions) {
  const { conversationRecord, globalConfig, modelRuntime, sessionManager } = options;
  let runtimeSessionManager = sessionManager;
  if (!runtimeSessionManager) {
    SessionManager.create(conversationRecord.workspaceDir, globalConfig.sessionsDir, {
      id: conversationRecord.id,
    });
  }

  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        systemPromptOverride: () => SYSTEM_PROMPT,
        additionalExtensionPaths: [
          // "npm:pi-web-access@0.28.0",
          webAccessExtensionPath,
        ],
        extensionFactories: [
          async (pi) => {
            // The package root ships TypeScript source that is incompatible with this app's type-check settings.
            const packageName = "pi-mcp-adapter";
            const { createMcpAdapter } = (await import(packageName)) as {
              createMcpAdapter(options: { configPath: string }): ExtensionFactory;
            };
            await createMcpAdapter({ configPath: globalConfig.mcpConfigPath })(pi);
          },
        ],
      },
    });
    const agentSession = await createAgentSessionFromServices({
      services,
      sessionManager,
      customTools: [utcTimeTool],
    });

    await agentSession.session.bindExtensions({});
    return {
      ...agentSession,
      services,
      diagnostics: services.diagnostics,
    };
  };
  return createAgentSessionRuntime(factory, {
    cwd: conversationRecord.workspaceDir,
    agentDir: getAgentDir(),
    sessionManager: runtimeSessionManager,
  });
}
