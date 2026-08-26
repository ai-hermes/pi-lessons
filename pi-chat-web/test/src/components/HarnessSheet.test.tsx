import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot, ToolSettingsView } from "@shared/types";
import { HarnessSheet } from "@/components/HarnessSheet";
import { TooltipProvider } from "@/components/ui/tooltip";

const snapshot: ConversationSnapshot = {
  conversation: { id: "c1", title: "Test", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 0, workspace: "/tmp/test", status: "ready" },
  messages: [],
  tools: [],
  thinking: [],
  model: { provider: "openai", id: "test" },
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "medium"],
  status: "ready",
  queue: { steering: [], followUp: [] },
  settings: {
    autoCompaction: true,
    autoRetry: true,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    queueDefaults: { steeringMode: "all", followUpMode: "one-at-a-time" },
    queueOverrides: { steeringMode: null, followUpMode: null },
  },
  stats: { sessionId: "c1", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, contextUsage: { tokens: 0, contextWindow: 100, percent: 0 } },
  stream: { id: "s1", lastEventId: 0 },
  activity: [],
  diagnostics: [],
};

const toolSettings: ToolSettingsView = {
  defaultEnabled: true,
  tools: [{ name: "web_search", description: "Search the web", source: { kind: "extension", label: "pi-web-access" }, globalEnabled: true, conversationOverride: null, effectiveEnabled: true }],
};

describe("HarnessSheet", () => {
  const props = { open: true, onOpenChange: vi.fn(), snapshot, onCompact: vi.fn(), toolSettings, onSettings: vi.fn().mockResolvedValue(undefined), onConversationTool: vi.fn().mockResolvedValue(undefined) };

  it("shows a clearly scoped session configuration tab", () => {
    render(<HarnessSheet {...props} />);
    expect(screen.getByRole("complementary", { name: "会话明细" })).toHaveClass("md:w-[32rem]");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("会话明细")).toBeInTheDocument();
    expect(screen.getByText("就绪")).toHaveClass("text-success");
    expect(screen.getByRole("region", { name: "模型信息" })).toHaveTextContent("openai/test");
    expect(screen.getByRole("region", { name: "模型信息" })).toHaveTextContent("思考强度 medium");
    expect(screen.getByRole("tab", { name: "活动" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("tab", { name: "上下文" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "本会话配置" })).toBeInTheDocument();
  });

  it("collapses its layout width when closed", () => {
    render(<HarnessSheet {...props} open={false} />);
    expect(screen.getByText("会话明细").closest("aside")).toHaveClass("w-0", "pointer-events-none");
  });

  it("opens the compaction dialog and submits instructions", async () => {
    const onCompact = vi.fn().mockResolvedValue(undefined);
    render(<HarnessSheet {...props} onCompact={onCompact} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "上下文" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: /压缩上下文/ }));
    fireEvent.change(screen.getByLabelText("自定义摘要指令"), { target: { value: "保留路径" } });
    fireEvent.click(screen.getByRole("button", { name: "开始压缩" }));
    await waitFor(() => expect(onCompact).toHaveBeenCalledWith("保留路径"));
  });

  it("copies the session ID without displaying it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<HarnessSheet {...props} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "上下文" }), { button: 0, ctrlKey: false });
    expect(screen.queryByText(snapshot.stats.sessionId)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制 Session ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(snapshot.stats.sessionId));
  });

  it("updates only this conversation's settings and tool override", async () => {
    const onSettings = vi.fn().mockResolvedValue(undefined);
    const onConversationTool = vi.fn().mockResolvedValue(undefined);
    render(<TooltipProvider><HarnessSheet {...props} onSettings={onSettings} onConversationTool={onConversationTool} /></TooltipProvider>);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "本会话配置" }), { button: 0, ctrlKey: false });
    expect(screen.queryByText("继承全局")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Steer 消费：全部" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Follow-up 消费：逐条" })).toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "自动压缩（本会话）" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Steer 消费：逐条" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Follow-up 消费：全部" }));
    fireEvent.click(screen.getByRole("switch", { name: "web_search（本会话）" }));
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith({ autoCompaction: false }));
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith({ queueOverrides: { steeringMode: "one-at-a-time" } }));
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith({ queueOverrides: { followUpMode: "all" } }));
    await waitFor(() => expect(onConversationTool).toHaveBeenCalledWith("web_search", false));
    expect(screen.getByText("只影响当前会话，不会修改全局设置。")).toBeInTheDocument();
    expect(screen.getByText("队列消费")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Steer 消费" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Follow-up 消费" })).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();
  });
});
