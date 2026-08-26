export type RuntimeStatus = "ready" | "running" | "stopping" | "compacting" | "error" | "cold";
export type QueueBehavior = "steer" | "followUp";
export type QueueMode = "all" | "one-at-a-time";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  imageInput: boolean;
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
  timestamp: number;
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
  startedAt: number;
  endedAt?: number;
}

export interface ThinkingBlock {
  id: string;
  text: string;
  timestamp: number;
}

export interface SessionStats {
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
}

export interface ConversationSettings {
  autoCompaction: boolean;
  autoRetry: boolean;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  queueDefaults?: GlobalQueueSettings;
  queueOverrides?: {
    steeringMode: QueueMode | null;
    followUpMode: QueueMode | null;
  };
}

export interface ConversationSettingsPatch {
  autoCompaction?: boolean;
  autoRetry?: boolean;
  queueOverrides?: {
    steeringMode?: QueueMode | null;
    followUpMode?: QueueMode | null;
  };
}

export interface GlobalQueueSettings {
  steeringMode: QueueMode;
  followUpMode: QueueMode;
}

export interface ToolSettingItem {
  name: string;
  description: string;
  source: {
    kind: "builtin" | "extension";
    label: string;
    path?: string;
  };
  globalEnabled: boolean;
  conversationOverride: boolean | null;
  effectiveEnabled: boolean;
}

export interface ToolSettingsView {
  defaultEnabled: true;
  tools: ToolSettingItem[];
}

export interface GlobalToolSettingItem {
  name: string;
  description: string;
  source: ToolSettingItem["source"];
  enabled: boolean;
}

export interface GlobalToolSettingsView {
  defaultEnabled: true;
  tools: GlobalToolSettingItem[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  workspace: string;
  parentId?: string;
  status: RuntimeStatus;
}

export interface ActivityItem {
  id: number;
  type: string;
  timestamp: string;
  summary: string;
  sourceId?: string;
}

export interface ConversationSnapshot {
  conversation: ConversationSummary;
  messages: ChatMessage[];
  tools: ToolRun[];
  thinking: ThinkingBlock[];
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  status: RuntimeStatus;
  error?: string;
  queue: { steering: string[]; followUp: string[] };
  settings: ConversationSettings;
  stats: SessionStats;
  stream: { id: string; lastEventId: number };
  activity: ActivityItem[];
  diagnostics: string[];
}

export interface BootstrapData {
  models: ModelOption[];
  warning: string;
  idleTtlMs: number;
  dataDir: string;
  repository?: RepositoryInfo;
}

export interface RepositoryInfo {
  branch: string;
  commit: string;
}

export interface StreamEvent<T = unknown> {
  id: number;
  streamId: string;
  type: string;
  timestamp: string;
  payload: T;
}
