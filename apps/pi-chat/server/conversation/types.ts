import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { EventChannel } from "./channel";
import type { RuntimeStatus } from "@shared/types";

export interface ConversationRecord {
    id: string;
    title: string;
    workspaceDir: string;
    sessionId: string;
    sessionFile: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface ManagedSession {
    id: string;
    runtime: AgentSessionRuntime;
    channel: EventChannel;
    unsubscribe?: () => void;
    status: RuntimeStatus;
    error?: string;
    diagnostics: string[];
    streamMessageId?: string;
    streamThinkingId?: string;
}