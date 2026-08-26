import { randomUUID } from "node:crypto";
import type { ActivityItem, StreamEvent } from "@shared/types";

type Listener = (event: StreamEvent) => void;

export class EventBuffer {
  readonly streamId = randomUUID();
  private sequence = 0;
  private readonly events: StreamEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly limit = 1_000) {}

  get lastId(): number {
    return this.sequence;
  }

  publish(type: string, payload: unknown = {}): StreamEvent {
    const event: StreamEvent = {
      id: ++this.sequence,
      streamId: this.streamId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  replay(after: number): { stale: boolean; events: StreamEvent[] } {
    const first = this.events[0]?.id ?? this.sequence + 1;
    return { stale: after > 0 && after < first - 1, events: this.events.filter((event) => event.id > after) };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activity(): ActivityItem[] {
    return this.events.slice(-100).reverse().map((event) => ({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      summary: summarizeEvent(event),
      sourceId: activitySourceId(event),
    }));
  }
}

function summarizeEvent(event: StreamEvent): string {
  const payload = event.payload as Record<string, unknown>;
  if (event.type.startsWith("tool.")) return `${String(payload.name ?? "tool")} · ${event.type.split(".").at(-1)}`;
  if (event.type.startsWith("retry.")) return `自动重试 ${String(payload.attempt ?? "")}`.trim();
  if (event.type.startsWith("compaction.")) return event.type.endsWith("started") ? "开始压缩上下文" : "上下文压缩完成";
  if (event.type === "queue.updated") return "消息队列已更新";
  if (event.type === "runtime.status") return `运行状态：${String(payload.status ?? "unknown")}`;
  return event.type;
}

function activitySourceId(event: StreamEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "message.added" || event.type === "message.completed") {
    const message = payload.message as { id?: unknown } | undefined;
    return typeof message?.id === "string" ? message.id : undefined;
  }
  if (event.type === "tool.started" || event.type === "tool.completed") {
    return typeof payload.id === "string" ? payload.id : undefined;
  }
  return undefined;
}
