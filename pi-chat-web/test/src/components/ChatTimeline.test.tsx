import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline } from "@/components/ChatTimeline";

describe("ChatTimeline", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("shows the product welcome only before a conversation is entered", () => {
    const { rerender } = render(<ChatTimeline showWelcome messages={[]} tools={[]} onBranch={vi.fn()} />);
    expect(screen.getByText("交给 Pi 来完成")).toBeInTheDocument();

    rerender(<ChatTimeline conversationId="c1" messages={[]} tools={[]} onBranch={vi.fn()} />);
    expect(screen.queryByText("交给 Pi 来完成")).not.toBeInTheDocument();
  });

  it("keeps conversation content hidden behind the initial welcome", () => {
    render(<ChatTimeline showWelcome conversationId="c1" messages={[{ id: "a", role: "assistant", text: "Existing reply", images: [], timestamp: 1 }]} tools={[]} onBranch={vi.fn()} />);
    expect(screen.getByText("交给 Pi 来完成")).toBeInTheDocument();
    expect(screen.queryByText("Existing reply")).not.toBeInTheDocument();
  });

  it("renders streaming assistant text and copies fenced code", async () => {
    const { rerender } = render(<ChatTimeline messages={[{ id: "a", role: "assistant", text: "working", images: [], timestamp: 1, streaming: true }]} tools={[]} onBranch={vi.fn()} />);
    expect(screen.getByLabelText("生成中")).toBeInTheDocument();

    rerender(<ChatTimeline messages={[{ id: "a", role: "assistant", text: "```ts\nconst answer = 42\n```", images: [], timestamp: 1 }]} tools={[]} onBranch={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "复制代码块" })); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("const answer = 42");
  });

  it("shows a relative timestamp below each message", () => {
    const timestamp = Date.now() - 5 * 60_000;
    render(<ChatTimeline messages={[{ id: "a", role: "assistant", text: "Answer", images: [], timestamp }]} tools={[]} onBranch={vi.fn()} />);
    expect(screen.getByText("5 分钟前")).toBeInTheDocument();
  });

  it("renders thinking as a separate collapsible timeline node", () => {
    render(<ChatTimeline messages={[{ id: "a", role: "assistant", text: "Answer", images: [], timestamp: 2 }]} tools={[]} thinking={[{ id: "a:thinking", text: "Reasoning details", timestamp: 1 }]} onBranch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /思考过程/ })).toBeInTheDocument();
    expect(screen.queryByText("Reasoning details")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));
    expect(screen.getByText("Reasoning details")).toBeInTheDocument();
    expect(screen.getAllByRole("article")[0]).toHaveTextContent("Answer");
  });

  it("edits a user message into a branch", async () => {
    const onBranch = vi.fn().mockResolvedValue(undefined);
    render(<ChatTimeline messages={[{ id: "u1", role: "user", text: "original", images: [], timestamp: 1 }]} tools={[]} onBranch={onBranch} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑并创建分支" }));
    fireEvent.change(screen.getByLabelText("消息"), { target: { value: "edited" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /创建分支/ })); });
    expect(onBranch).toHaveBeenCalledWith("u1", "edited");
  });

  it("offers a jump control when the reader scrolls away from live output", () => {
    const { container } = render(<ChatTimeline conversationId="c1" messages={[{ id: "a", role: "assistant", text: "long output", images: [], timestamp: 1 }]} tools={[]} onBranch={vi.fn()} />);
    const viewport = container.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    expect(viewport).not.toBeNull();
    Object.defineProperties(viewport!, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(viewport!);
    const jump = screen.getByRole("button", { name: "回到最新" });
    expect(jump).toBeInTheDocument();
    expect(jump.parentElement).toHaveAttribute("data-slot", "jump-latest");
    expect(viewport).not.toContainElement(jump);
  });

  it("differentiates user and assistant surfaces with actions outside their borders", () => {
    render(<ChatTimeline messages={[
      { id: "u", role: "user", text: "Question", images: [], timestamp: 1 },
      { id: "a", role: "assistant", text: "Answer", images: [], timestamp: 2 },
    ]} tools={[]} onBranch={vi.fn()} />);

    const articles = screen.getAllByRole("article");
    expect(articles[0].querySelector('[data-slot="message-bubble"]')).toHaveClass("bg-muted", "rounded-2xl", "px-3", "py-2");
    expect(articles[1].querySelector('[data-slot="message-bubble"]')).toHaveClass("bg-transparent", "px-0");
    for (const article of articles) {
      expect(article).toHaveClass("py-1");
      expect(article.querySelector('[data-slot="message-bubble"]')).toHaveClass("text-sm");
      const actions = article.querySelector('[data-slot="message-actions"]');
      expect(actions).toBeInTheDocument();
      expect(actions?.closest('[data-slot="message-bubble"]')).toBeNull();
    }
    expect(screen.queryByText("Pi")).not.toBeInTheDocument();
  });

  it("renders the optimistic user input without a sending status", () => {
    render(<ChatTimeline conversationId="c1" messages={[
      { id: "optimistic_1", role: "user", text: "Question", images: [], timestamp: 10, pending: true },
      { id: "stream_1", role: "assistant", text: "Answer", images: [], timestamp: 11, streaming: true },
    ]} tools={[]} onBranch={vi.fn()} />);
    const articles = screen.getAllByRole("article");
    expect(articles[0]).toHaveTextContent("Question");
    expect(screen.queryByText("发送中")).not.toBeInTheDocument();
    expect(articles[1]).toHaveTextContent("Answer");
  });

  it("renders one replying indicator at the bottom of the message flow", () => {
    const { container } = render(<ChatTimeline conversationId="c1" messages={[
      { id: "stream_1", role: "assistant", text: "First reply", images: [], timestamp: 1, streaming: true },
      { id: "stream_2", role: "assistant", text: "Latest reply", images: [], timestamp: 2, streaming: true },
    ]} tools={[]} onBranch={vi.fn()} />);

    expect(screen.getAllByLabelText("生成中")).toHaveLength(1);
    const indicator = container.querySelector('[data-slot="replying-indicator"]');
    expect(indicator).toHaveTextContent("正在回复");
    expect(indicator?.previousElementSibling).toHaveTextContent("Latest reply");
  });

  it("renders consecutive tool calls without an outer run summary", () => {
    const { container } = render(<ChatTimeline conversationId="c1" messages={[
      { id: "u1", role: "user", text: "Build it", images: [], timestamp: 1 },
      { id: "a1", role: "assistant", text: "Working", images: [], timestamp: 2 },
    ]} tools={[
      { id: "t1", name: "write", args: { path: "a.ts" }, status: "success", startedAt: 3, endedAt: 4 },
      { id: "t2", name: "edit", args: { path: "a.ts" }, status: "success", startedAt: 5, endedAt: 6 },
      { id: "t3", name: "bash", args: { command: "test" }, status: "error", result: "exit code: 1", startedAt: 7, endedAt: 8 },
    ]} onBranch={vi.fn()} />);

    expect(screen.queryByText("执行记录")).not.toBeInTheDocument();
    expect(screen.queryByText("3 个步骤 · 含失败步骤")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="run-steps"]')).not.toHaveClass("divide-y");
    expect(container.querySelectorAll('[data-slot="tool-call-row"]')).toHaveLength(3);
    expect(container.querySelector('[data-slot="tool-call-row"]')).not.toHaveClass("rounded-lg", "border");
    expect(container.querySelector('[data-slot="run-group-row"]')).not.toHaveClass("md:pl-10");
    expect(container.querySelector('[data-slot="tool-call-row"] > button')).toHaveClass("min-h-10", "gap-2", "px-2.5");
  });
});
