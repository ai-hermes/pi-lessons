import type { ChatMessage, StreamEvent } from "@shared/types";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function eventFactory(streamId: string) {
  let id = 0;
  return (type: StreamEvent["type"], payload: unknown): StreamEvent => ({
    id: ++id,
    streamId,
    type,
    payload,
  });
}

export async function playMockConversation(
  text: string,
  onEvent: (event: StreamEvent) => void,
  isCancelled: () => boolean,
) {
  const streamId = crypto.randomUUID();
  const assistantId = crypto.randomUUID();
  const thinkingId = crypto.randomUUID();
  const toolId = crypto.randomUUID();
  const createEvent = eventFactory(streamId);
  const emit = async (type: StreamEvent["type"], payload: unknown) => {
    await wait(180);
    if (!isCancelled()) onEvent(createEvent(type, payload));
  };
  const emitDeltas = async (
    type: "thinking.delta" | "message.delta",
    id: string,
    value: string,
  ) => {
    for (let index = 0; index < value.length; index += 12) {
      const delta = value.slice(index, index + 12);
      await emit(type, { id, delta });
      if (isCancelled()) return;
    }
  };

  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    text,
    images: [],
  };
  const answer =
    "我来帮你处理：**" +
    text +
    "**。\n\n我先梳理需求，再通过工具完成一次示例操作，最后给出结果。";

  await emit("runtime.status", { status: "running" });
  await emit("message.added", userMessage);
  await emit("message.started", { id: assistantId });
  await emit("thinking.started", { id: thinkingId });
  await emitDeltas(
    "thinking.delta",
    thinkingId,
    "我先分析用户的问题，确认需要执行的步骤，然后调用工具获取结果。",
  );
  await emit("thinking.completed", { id: thinkingId });
  await emit("tool.started", {
    id: toolId,
    name: "search",
    args: { query: text },
  });
  await emit("tool.updated", {
    id: toolId,
    name: "search",
    args: { query: text },
    result: "正在搜索相关信息…",
  });
  await emit("tool.completed", {
    id: toolId,
    name: "search",
    status: "success",
    result: "找到 3 条相关结果",
    details: { count: 3, source: "mock" },
  });
  await emitDeltas("message.delta", assistantId, answer);
  const message: ChatMessage = {
    id: assistantId,
    role: "assistant",
    text: answer,
    images: [],
  };
  await emit("message.completed", { id: assistantId, message });
  await emit("runtime.status", { status: "ready" });
  await emit("runtime.settled", {});
}
