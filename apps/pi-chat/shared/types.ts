export type RuntimeStatus =
  | "ready"
  | "running"
  | "waiting_for_human"
  | "stopping"
  | "compacting"
  | "error"
  | "cold";

export interface BrowserHandoffRequest {
  id: string;
  conversationId: string;
  toolCallId: string;
  reason: string;
  expiresAt: number;
}

/** Browser operation phase, separate from the server-side sandbox controller lifecycle. */
export const BrowserPhase = {
  /** No browser connection is currently ready for use. */
  Stopped: "stopped",
  /** Creating or connecting to the sandbox and waiting for Chrome. */
  Starting: "starting",
  /** Importing the saved browser state. */
  Loading: "loading",
  /** The browser is ready for operations. */
  Ready: "ready",
  /** Exporting and persisting browser state. */
  Saving: "saving",
  /** Terminating the sandbox and clearing its record. */
  Releasing: "releasing",
  /** The last browser operation failed. */
  Error: "error",
} as const;

export type BrowserPhase = (typeof BrowserPhase)[keyof typeof BrowserPhase];

export interface BrowserState {
  phase: BrowserPhase;
  sandboxId?: string;
  vncUrl?: string;
  savedAt?: string;
  loadedAt?: string;
  error?: string;
}
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { ThinkingLevel };

export type EventType =
  | "browser.handoff.changed"
  | "browser.state"
  | "runtime.status"
  | "runtime.error"
  | "runtime.settled"
  | "message.delta"
  | "message.started"
  | "message.added"
  | "message.completed"
  | "thinking.started"
  | "thinking.delta"
  | "thinking.completed"
  | "tool.started"
  | "tool.updated"
  | "tool.completed";

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
  timestamp?: number | string;
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
  images?: ChatImage[];
  details?: unknown;
}

export interface ThinkingBlock {
  id: string;
  text: string;
  completed?: boolean;
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
  browser?: BrowserState;
  browserHandoff?: BrowserHandoffRequest;
  conversation: ConversationSummary;
  messageList: MessageListItem[];
  activeSkillNames: string[];
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

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  imageInput: boolean;
  thinkingLevels: ThinkingLevel[];
}

export interface SkillOption {
  name: string;
  description: string;
}

export interface RepositoryInfo {
  branch: string;
  commit: string;
}

export interface BootstrapData {
  browser?: { enabled: true };
  models: ModelOption[];
  repository?: RepositoryInfo;
  skills: SkillOption[];
}

export interface ConversationConfig {
  model: { provider: string; id: string };
  models: ModelOption[];
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
}

export interface ConversationConfigUpdate {
  model?: {
    provider: string;
    id: string;
  };
  thinkingLevel?: ThinkingLevel;
}
