import {
    createAgentSessionRuntime, getAgentDir, SessionManager, createAgentSessionServices, ModelRuntime, createAgentSessionFromServices,
    type CreateAgentSessionRuntimeFactory
} from '@earendil-works/pi-coding-agent'
import type { ConversationRecord } from './types';
import type { GlobalConfig } from '@server/config';


export interface RuntimeOptions {
    conversationRecord: ConversationRecord;
    globalConfig: GlobalConfig;
    modelRuntime: ModelRuntime;
    sessionManager: SessionManager;
}


const SYSTEM_PROMPT = `You are Pi Chat, a helpful, precise coding assistant running in a dedicated conversation workspace.

You can inspect files, run commands, and edit the workspace. Explain important actions and summarize concrete results. Prefer small, verifiable changes. Never claim a command or edit succeeded unless its tool result confirms it.

The workspace is a convenience boundary, not an operating-system sandbox. Stay inside the current working directory unless the user explicitly asks otherwise. Do not expose credentials or secrets. Reply in the user's language.`;


export async function createRuntime(options: RuntimeOptions) {
    const { conversationRecord, globalConfig, modelRuntime, sessionManager } = options
    let runtimeSessionManager = sessionManager;
    if (!runtimeSessionManager) {
        SessionManager.create(conversationRecord.workspaceDir, globalConfig.sessionsDir, {
            id: conversationRecord.id
        })
    }

    const factory: CreateAgentSessionRuntimeFactory = async ({
        cwd, agentDir, sessionManager
    }) => {
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            modelRuntime,
            resourceLoaderOptions: {
                noExtensions: true,
                systemPromptOverride: () => SYSTEM_PROMPT
            }
        })
        const agentSession = await createAgentSessionFromServices({
            services,
            sessionManager,
        })
        return {
            ...agentSession,
            services,
            diagnostics: services.diagnostics
        }
    }
    return createAgentSessionRuntime(
        factory,
        {
            cwd: conversationRecord.workspaceDir,
            agentDir: getAgentDir(),
            sessionManager: runtimeSessionManager
        }
    )

}