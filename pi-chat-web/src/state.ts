import type { ConversationSnapshot, StreamEvent, ToolRun } from "../shared/types";

export type SnapshotAction =
  | { type: "snapshot"; snapshot: ConversationSnapshot }
  | { type: "event"; event: StreamEvent }
  | { type: "user.optimistic"; message: ConversationSnapshot["messages"][number] }
  | { type: "user.rollback"; id: string };

function upsertTool(tools: ToolRun[], patch: Partial<ToolRun> & { id: string }): ToolRun[] {
  const current = tools.find((tool) => tool.id === patch.id);
  if (!current) {
    return [...tools, {
      ...patch,
      id: patch.id,
      name: patch.name ?? "tool",
      args: patch.args ?? {},
      status: patch.status ?? "running",
      startedAt: patch.startedAt ?? Date.now(),
    }];
  }
  return tools.map((tool) => tool.id === patch.id ? { ...tool, ...patch } : tool);
}

export function snapshotReducer(state: ConversationSnapshot | undefined, action: SnapshotAction): ConversationSnapshot | undefined {
  if (action.type === "snapshot") return action.snapshot;
  if (!state) return state;
  if (action.type === "user.optimistic") {
    return state.messages.some((message) => message.id === action.message.id)
      ? state
      : { ...state, messages: [...state.messages, action.message] };
  }
  if (action.type === "user.rollback") {
    return { ...state, messages: state.messages.filter((message) => message.id !== action.id) };
  }
  const event = action.event;
  const payload = event.payload as Record<string, any>;
  const base = { ...state, stream: { ...state.stream, lastEventId: Math.max(state.stream.lastEventId, event.id) } };
  const activity = event.type === "message.delta"
    ? state.activity
    : [{ id: event.id, type: event.type, timestamp: event.timestamp, summary: event.type }, ...state.activity].slice(0, 100);
  const next = { ...base, activity };

  switch (event.type) {
    case "message.started":
      return state.messages.some((message) => message.id === payload.id) ? next : {
        ...next,
        messages: [...state.messages, { id: payload.id, role: "assistant", text: "", images: [], timestamp: payload.timestamp, streaming: true }],
      };
    case "message.delta":
      return { ...next, messages: state.messages.map((message) => message.id === payload.id ? { ...message, text: message.text + payload.delta, streaming: true } : message) };
    case "message.added": {
      if (state.messages.some((message) => message.id === payload.message.id)) return next;
      const optimisticIndex = payload.message.role === "user"
        ? state.messages.findIndex((message) => message.pending && message.role === "user" && message.text === payload.message.text)
        : -1;
      if (optimisticIndex < 0) return { ...next, messages: [...state.messages, payload.message] };
      return {
        ...next,
        messages: state.messages.map((message, index) => index === optimisticIndex
          ? { ...payload.message, timestamp: Math.min(message.timestamp, payload.message.timestamp), pending: false }
          : message),
      };
    }
    case "message.completed":
      return { ...next, messages: [...state.messages.filter((message) => message.id !== payload.streamId && message.id !== payload.message.id), payload.message] };
    case "tool.started":
      return { ...next, tools: upsertTool(state.tools, { ...payload, id: String(payload.id), status: "running" }) };
    case "tool.updated":
      return { ...next, tools: upsertTool(state.tools, { ...payload, id: String(payload.id) }) };
    case "tool.completed":
      return { ...next, tools: upsertTool(state.tools, { ...payload, id: String(payload.id) }) };
    case "queue.updated":
      return { ...next, queue: { steering: payload.steering ?? [], followUp: payload.followUp ?? [] } };
    case "runtime.status":
      return { ...next, status: payload.status, conversation: { ...state.conversation, status: payload.status }, error: undefined };
    case "runtime.error":
      return { ...next, status: "error", error: String(payload.error ?? "Unknown error") };
    case "model.changed":
      return { ...next, model: { provider: payload.provider, id: payload.id } };
    case "thinking.changed":
      return { ...next, thinkingLevel: payload.level };
    case "settings.changed":
      return { ...next, settings: payload as ConversationSnapshot["settings"] };
    case "conversation.renamed":
      return { ...next, conversation: { ...state.conversation, title: payload.title } };
    default:
      return next;
  }
}
