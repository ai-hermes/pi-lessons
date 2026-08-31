export type RuntimeStatus = "ready" | "running" | "stopping" | "compacting" | "error" | "cold";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { ThinkingLevel };


export type EventType =
    "runtime.status" | "runtime.error" | "runtime.settled" |
    "message.delta" | "message.started" | "message.added" | "message.completed" |
    "thinking.started" | "thinking.delta" | "thinking.completed" |
    "tool.started" | "tool.updated" | "tool.completed";

export interface StreamEvent<T = unknown> {
    id: number;
    streamId: string;
    type: EventType;
    payload: T;
}

export interface ChatImage {
    type: "image";
    mimeType: string;
    data: string;
}

export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    text: string;
    images: ChatImage[];
    streaming?: boolean;
    pending?: boolean;
    error?: string;
}

export interface ToolRun {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: "running" | "success" | "error";
    result?: string;
    details?: unknown;
}

export interface ThinkingBlock {
    id: string;
    text: string;
}

export type MessageListToolItem = {
    kind: "tool";
    id: string;
    tool: ToolRun;
    seqId?: number;
};

export type MessageListItem =
    | { kind: "message"; id: string; message: ChatMessage; seqId?: number }
    | { kind: "thinking"; id: string; thinking: ThinkingBlock; seqId?: number }
    | MessageListToolItem;

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceDir: string;
  parentId?: string;
  status: RuntimeStatus;
}

export interface ConversationSnapshot {
  conversation: ConversationSummary;
  messageList: MessageListItem[];
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  status: RuntimeStatus;
  error?: string;
  stream: { id: string; lastEventId: number };
  diagnostics: string[];
}

export interface CreateConversationResponse {
  conversation: { id: string };
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  stream: { id: string; lastEventId: number };
  diagnostics: string[];
}
