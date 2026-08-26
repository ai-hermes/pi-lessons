import { describe, expect, it } from "vitest";
import type { ConversationSnapshot, StreamEvent } from "@shared/types";
import { snapshotReducer } from "@/state";

const snapshot: ConversationSnapshot = {
  conversation: { id: "c1", title: "Chat", createdAt: "2026-01-01", updatedAt: "2026-01-01", messageCount: 0, workspace: "/tmp/chat", status: "ready" },
  messages: [], tools: [], thinking: [], model: { provider: "test", id: "model" }, thinkingLevel: "off", availableThinkingLevels: ["off"],
  status: "ready", queue: { steering: [], followUp: [] }, settings: { autoCompaction: true, autoRetry: true, steeringMode: "all", followUpMode: "all" },
  stats: { sessionId: "c1", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
  stream: { id: "s1", lastEventId: 0 }, activity: [], diagnostics: [],
};

function event(id: number, type: string, payload: unknown): StreamEvent {
  return { id, streamId: "s1", type, timestamp: new Date().toISOString(), payload };
}

describe("snapshotReducer", () => {
  it("streams assistant deltas and replaces the temporary message", () => {
    let state = snapshotReducer(snapshot, { type: "event", event: event(1, "message.started", { id: "temp", timestamp: 1 }) })!;
    state = snapshotReducer(state, { type: "event", event: event(2, "message.delta", { id: "temp", delta: "Hi" }) })!;
    state = snapshotReducer(state, { type: "event", event: event(3, "message.completed", { streamId: "temp", message: { id: "a1", role: "assistant", text: "Hi", images: [], timestamp: 1 } }) })!;
    expect(state.messages).toEqual([{ id: "a1", role: "assistant", text: "Hi", images: [], timestamp: 1 }]);
    expect(state.activity.map((item) => item.type)).toEqual(["message.completed", "message.started"]);
  });

  it("upserts repeated tool updates", () => {
    let state = snapshotReducer(snapshot, { type: "event", event: event(1, "tool.started", { id: "t1", name: "bash", args: { command: "pwd" }, startedAt: 1 }) })!;
    state = snapshotReducer(state, { type: "event", event: event(2, "tool.completed", { id: "t1", name: "bash", status: "success", result: "/tmp", endedAt: 2 }) })!;
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ status: "success", result: "/tmp" });
  });

  it("keeps an optimistic user message ahead of an early assistant stream", () => {
    let state = snapshotReducer(snapshot, { type: "user.optimistic", message: {
      id: "optimistic_1", role: "user", text: "question", images: [], timestamp: 100, pending: true,
    } })!;
    state = snapshotReducer(state, { type: "event", event: event(1, "message.started", { id: "stream_1", timestamp: 101 }) })!;
    state = snapshotReducer(state, { type: "event", event: event(2, "message.added", { message: {
      id: "u1", role: "user", text: "question", images: [], timestamp: 102,
    } }) })!;

    expect(state.messages.map((message) => message.id)).toEqual(["u1", "stream_1"]);
    expect(state.messages[0]).toMatchObject({ pending: false, timestamp: 100 });
  });

  it("rolls back a rejected optimistic user message", () => {
    let state = snapshotReducer(snapshot, { type: "user.optimistic", message: {
      id: "optimistic_1", role: "user", text: "question", images: [], timestamp: 100, pending: true,
    } })!;
    state = snapshotReducer(state, { type: "user.rollback", id: "optimistic_1" })!;
    expect(state.messages).toEqual([]);
  });
});
