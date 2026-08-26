import type { ActivityItem, ChatMessage, ThinkingBlock, ToolRun } from "@shared/types";

interface EntryLike {
  id: string;
  type: string;
  timestamp: string;
  message?: MessageLike;
}

interface MessageLike {
  role: string;
  content: string | ContentLike[];
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  errorMessage?: string;
}

interface ContentLike {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export function projectTranscript(entries: readonly unknown[]): { messages: ChatMessage[]; tools: ToolRun[]; thinking: ThinkingBlock[]; activity: ActivityItem[] } {
  const messages: ChatMessage[] = [];
  const thinking: ThinkingBlock[] = [];
  const tools = new Map<string, ToolRun>();
  let previousTimestamp = 0;

  for (const raw of entries) {
    const entry = raw as EntryLike;
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    // Queued steer/follow-up messages retain their enqueue timestamp. Use the
    // session entry timestamp for user messages so the timeline reflects delivery order.
    const candidateTimestamp = message.role === "user"
      ? Date.parse(entry.timestamp)
      : message.timestamp || Date.parse(entry.timestamp);
    const timestamp = Math.max(Number.isFinite(candidateTimestamp) ? candidateTimestamp : Date.now(), previousTimestamp + 1);
    previousTimestamp = timestamp;
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;

    if (message.role === "user" || message.role === "assistant") {
      const text = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
      const images = content
        .filter((part) => part.type === "image" && part.data && part.mimeType)
        .map((part) => ({ type: "image" as const, data: part.data!, mimeType: part.mimeType! }));
      if (message.role === "user" || text || message.errorMessage) {
        messages.push({
          id: entry.id,
          role: message.role,
          text,
          images,
          timestamp,
          ...(message.errorMessage ? { error: message.errorMessage } : {}),
        });
      }
      if (message.role === "assistant") {
        const thought = content.filter((part) => part.type === "thinking").map((part) => part.thinking ?? "").join("");
        if (thought) thinking.push({ id: `${entry.id}:thinking`, text: thought, timestamp });
        for (const part of content.filter((item) => item.type === "toolCall")) {
          if (!part.id || !part.name) continue;
          tools.set(part.id, {
            id: part.id,
            name: part.name,
            args: part.arguments ?? {},
            status: "running",
            startedAt: timestamp,
          });
        }
      }
      continue;
    }

    if (message.role === "toolResult" && message.toolCallId) {
      const current = tools.get(message.toolCallId);
      const result = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      tools.set(message.toolCallId, {
        id: message.toolCallId,
        name: message.toolName ?? current?.name ?? "tool",
        args: current?.args ?? {},
        status: message.isError ? "error" : "success",
        result,
        details: message.details,
        startedAt: current?.startedAt ?? timestamp,
        endedAt: timestamp,
      });
    }
  }

  const projectedTools = [...tools.values()].sort((a, b) => a.startedAt - b.startedAt);
  const activity = [
    ...messages.map((message) => ({
      type: message.role === "user" ? "message.added" : "message.completed",
      timestamp: new Date(message.timestamp).toISOString(),
      summary: message.role === "user" ? "用户消息" : "回复生成完成",
      sourceId: message.id,
    })),
    ...projectedTools.flatMap((tool) => [
      { type: "tool.started", timestamp: new Date(tool.startedAt).toISOString(), summary: `${tool.name} · started`, sourceId: tool.id },
      ...(tool.endedAt ? [{ type: "tool.completed", timestamp: new Date(tool.endedAt).toISOString(), summary: `${tool.name} · ${tool.status}`, sourceId: tool.id }] : []),
    ]),
  ]
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, 100)
    .map((item, index) => ({ ...item, id: -index - 1 }));

  return { messages, tools: projectedTools, thinking, activity };
}

export function projectEntry(raw: unknown): ChatMessage | undefined {
  return projectTranscript([raw]).messages[0];
}
