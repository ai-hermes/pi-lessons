import type {
  BootstrapData,
  ConversationSnapshot,
  ConversationSummary,
  ConversationSettings,
  ConversationSettingsPatch,
  GlobalQueueSettings,
  GlobalToolSettingsView,
  QueueBehavior,
  StreamEvent,
  ThinkingLevel,
  ToolSettingsView,
} from "../shared/types";

async function response<T>(request: Promise<Response>): Promise<T> {
  const result = await request;
  if (!result.ok) {
    const body = await result.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `${result.status} ${result.statusText}`);
  }
  return result.status === 204 ? undefined as T : await result.json() as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const getBootstrap = () => response<BootstrapData>(fetch("/api/bootstrap"));
export const listConversations = () => response<ConversationSummary[]>(fetch("/api/conversations"));
export const createConversation = () => response<ConversationSnapshot>(fetch("/api/conversations", { method: "POST" }));
export const importConversation = (file: File) => {
  const form = new FormData();
  form.set("file", file);
  return response<ConversationSnapshot>(fetch("/api/conversations/import", { method: "POST", body: form }));
};
export const getConversation = (id: string) => response<ConversationSnapshot>(fetch(`/api/conversations/${id}`));
export const renameConversation = (id: string, title: string) => response<ConversationSummary>(fetch(`/api/conversations/${id}`, { ...json({ title }), method: "PATCH" }));
export const deleteConversation = (id: string) => response<void>(fetch(`/api/conversations/${id}`, { method: "DELETE" }));

export async function sendMessage(id: string, text: string, files: File[], behavior: QueueBehavior): Promise<void> {
  const form = new FormData();
  form.set("text", text);
  form.set("behavior", behavior);
  for (const file of files) form.append("files", file);
  await response(fetch(`/api/conversations/${id}/messages`, { method: "POST", body: form }));
}

export const abortRun = (id: string) => response(fetch(`/api/conversations/${id}/abort`, json({})));
export const setModel = (id: string, provider: string, modelId: string) => response(fetch(`/api/conversations/${id}/model`, json({ provider, id: modelId })));
export const setThinking = (id: string, level: ThinkingLevel) => response(fetch(`/api/conversations/${id}/thinking`, json({ level })));
export const compactConversation = (id: string, instructions: string) => response(fetch(`/api/conversations/${id}/compact`, json({ instructions })));
export const updateConversationSettings = (id: string, settings: ConversationSettingsPatch) => response<ConversationSettings>(fetch(`/api/conversations/${id}/settings`, { ...json(settings), method: "PATCH" }));
export const getToolSettings = (id: string) => response<ToolSettingsView>(fetch(`/api/conversations/${id}/tools`));
export const updateConversationTool = (id: string, name: string, enabled: boolean | null) => response<ToolSettingsView>(fetch(`/api/conversations/${id}/tools`, { ...json({ name, enabled }), method: "PATCH" }));
export const getGlobalToolSettings = () => response<GlobalToolSettingsView>(fetch("/api/settings/tools"));
export const updateGlobalTool = (name: string, enabled: boolean) => response<GlobalToolSettingsView>(fetch("/api/settings/tools", { ...json({ name, enabled }), method: "PATCH" }));
export const getGlobalQueueSettings = () => response<GlobalQueueSettings>(fetch("/api/settings/queue"));
export const updateGlobalQueueSettings = (settings: Partial<GlobalQueueSettings>) => response<GlobalQueueSettings>(fetch("/api/settings/queue", { ...json(settings), method: "PATCH" }));
export const branchConversation = (id: string, entryId: string, text: string) => response<ConversationSnapshot>(fetch(`/api/conversations/${id}/branches`, json({ entryId, text })));

export function connectEvents(
  conversationId: string,
  streamId: string,
  after: number,
  onEvent: (event: StreamEvent) => void,
  onConnection: (connected: boolean) => void,
): EventSource {
  const query = new URLSearchParams({ streamId, after: String(after) });
  const source = new EventSource(`/api/conversations/${conversationId}/events?${query}`);
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  source.onmessage = (message) => {
    try { onEvent(JSON.parse(message.data) as StreamEvent); }
    catch { onConnection(false); }
  };
  return source;
}
