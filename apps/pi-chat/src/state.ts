import type {
  ChatMessage,
  MessageListItem,
  StreamEvent,
  ThinkingBlock,
  ToolRun,
} from "../shared/types";

export type ConversationAction =
  | { type: "event"; event: StreamEvent }
  | { type: "optimistic-user"; message: ChatMessage };

type EventPayload = Record<string, unknown>;

function eventPayload(event: StreamEvent): EventPayload {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as EventPayload)
    : {};
}

function updateItem(
  items: MessageListItem[],
  id: string,
  update: (item: MessageListItem) => MessageListItem,
): MessageListItem[] {
  return items.map((item) => (item.id === id ? update(item) : item));
}

function addUserMessage(
  items: MessageListItem[],
  message: ChatMessage,
): MessageListItem[] {
  if (items.some((item) => item.kind === "message" && item.id === message.id))
    return items;
  const pendingIndex = items.findIndex(
    (item) =>
      item.kind === "message" &&
      item.message.role === "user" &&
      item.message.pending &&
      item.message.text === message.text,
  );
  if (pendingIndex < 0)
    return [...items, { kind: "message", id: message.id, message }];
  return items.map((item, index) =>
    index === pendingIndex
      ? {
        kind: "message",
        id: message.id,
        message: { ...message, pending: false },
      }
      : item,
  );
}

function addOrUpdateTool(
  items: MessageListItem[],
  tool: ToolRun,
): MessageListItem[] {
  const exists = items.some(
    (item) => item.kind === "tool" && item.id === tool.id,
  );
  if (!exists) return [...items, { kind: "tool", id: tool.id, tool }];
  return updateItem(items, tool.id, (item) =>
    item.kind === "tool" ? { ...item, tool: { ...item.tool, ...tool } } : item,
  );
}

function addOrUpdateMessage(
  items: MessageListItem[],
  message: ChatMessage,
): MessageListItem[] {
  const index = items.findIndex(
    (item) => item.kind === "message" && item.id === message.id,
  );
  if (index < 0)
    return [...items, { kind: "message", id: message.id, message }];

  return items.map((item, itemIndex) =>
    itemIndex === index ? { kind: "message", id: message.id, message } : item,
  );
}

export function conversationReducer(
  items: MessageListItem[],
  action: ConversationAction,
): MessageListItem[] {
  if (action.type === "optimistic-user")
    return addUserMessage(items, action.message);
  const payload = eventPayload(action.event);
  const id = typeof payload.id === "string" ? payload.id : "";

  switch (action.event.type) {
    case "message.added":
      return addUserMessage(items, payload as unknown as ChatMessage);
    case "message.started": {
      // The start event only establishes the assistant stream. Do not render
      // an empty bubble before the thinking block arrives.
      return items;
    }
    case "message.delta": {
      if (!id) return items;
      const item = items.find(
        (current) => current.kind === "message" && current.id === id,
      );
      const delta = String(payload.delta ?? "");
      if (!item) {
        return addOrUpdateMessage(items, {
          id,
          role: "assistant",
          text: delta,
          images: [],
          streaming: true,
        });
      }
      return updateItem(items, id, (current) =>
        current.kind === "message"
          ? {
            ...current,
            message: {
              ...current.message,
              text: current.message.text + delta,
              streaming: true,
            },
          }
          : current,
      );
    }
    case "message.completed": {
      const message = payload.message as ChatMessage | undefined;
      if (!message) return items;
      const streamId =
        typeof payload.streamId === "string" ? payload.streamId : id;
      const withoutPrevious = items.filter(
        (item) => item.id !== streamId && item.id !== message.id,
      );
      const previousIndex = items.findIndex(
        (item) => item.id === streamId || item.id === message.id,
      );
      const completed = {
        kind: "message" as const,
        id: message.id,
        message: { ...message, streaming: false },
      };
      if (previousIndex < 0) return [...withoutPrevious, completed];
      const insertIndex = Math.min(previousIndex, withoutPrevious.length);
      return [
        ...withoutPrevious.slice(0, insertIndex),
        completed,
        ...withoutPrevious.slice(insertIndex),
      ];
    }
    case "thinking.started": {
      if (
        !id ||
        items.some((item) => item.kind === "thinking" && item.id === id)
      )
        return items;
      const thinking: ThinkingBlock = { id, text: "" };
      return [...items, { kind: "thinking", id, thinking }];
    }
    case "thinking.delta":
      return updateItem(items, id, (item) =>
        item.kind === "thinking"
          ? {
            ...item,
            thinking: {
              ...item.thinking,
              text: item.thinking.text + String(payload.delta ?? ""),
            },
          }
          : item,
      );
    case "tool.started":
      return addOrUpdateTool(items, {
        id,
        name: String(payload.name ?? "tool"),
        args: (payload.args ?? {}) as Record<string, unknown>,
        status: "running",
      });
    case "tool.updated":
    case "tool.completed":
      return addOrUpdateTool(items, {
        id,
        name: String(payload.name ?? "tool"),
        args: (payload.args ?? {}) as Record<string, unknown>,
        status:
          action.event.type === "tool.completed"
            ? payload.status === "error"
              ? "error"
              : "success"
            : "running",
        ...(typeof payload.result === "string"
          ? { result: payload.result }
          : {}),
        ...(payload.details !== undefined ? { details: payload.details } : {}),
      });
    default:
      return items;
  }
}
