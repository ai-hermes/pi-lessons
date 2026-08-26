import { describe, expect, it } from "vitest";
import { projectTranscript } from "@server/projection";

describe("projectTranscript", () => {
  it("projects thinking and joins tool calls with results", () => {
    const timestamp = Date.now();
    const entries = [
      { id: "u1", type: "message", timestamp: new Date(timestamp).toISOString(), message: { role: "user", timestamp, content: "Inspect files" } },
      { id: "a1", type: "message", timestamp: new Date(timestamp + 1).toISOString(), message: { role: "assistant", timestamp: timestamp + 1, content: [
        { type: "thinking", thinking: "hidden" },
        { type: "toolCall", id: "t1", name: "ls", arguments: { path: "." } },
      ] } },
      { id: "t1-result", type: "message", timestamp: new Date(timestamp + 2).toISOString(), message: { role: "toolResult", timestamp: timestamp + 2, toolCallId: "t1", toolName: "ls", isError: false, content: [{ type: "text", text: "README.md" }] } },
      { id: "a2", type: "message", timestamp: new Date(timestamp + 3).toISOString(), message: { role: "assistant", timestamp: timestamp + 3, content: [{ type: "text", text: "Done" }] } },
    ];
    const result = projectTranscript(entries);
    expect(result.messages.map((message) => message.text)).toEqual(["Inspect files", "Done"]);
    expect(result.thinking).toEqual([{ id: "a1:thinking", text: "hidden", timestamp: timestamp + 1 }]);
    expect(result.tools[0]).toMatchObject({ id: "t1", name: "ls", status: "success", result: "README.md" });
    expect(result.activity.map((item) => item.type)).toEqual(["message.completed", "tool.completed", "tool.started", "message.added"]);
  });

  it("preserves session entry order when raw timestamps are equal or reversed", () => {
    const timestamp = Date.now();
    const result = projectTranscript([
      { id: "u1", type: "message", timestamp: new Date(timestamp).toISOString(), message: { role: "user", timestamp, content: "Question" } },
      { id: "a1", type: "message", timestamp: new Date(timestamp - 10).toISOString(), message: { role: "assistant", timestamp: timestamp - 10, content: "Answer" } },
    ]);

    expect(result.messages.map((message) => message.text)).toEqual(["Question", "Answer"]);
    expect(result.messages[0].timestamp).toBeLessThan(result.messages[1].timestamp);
  });
});
