import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/Composer";

const controls = {
  models: [{ provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 200_000, reasoning: true, imageInput: true }],
  model: { provider: "openai", id: "gpt-5.6-sol" },
  thinkingLevel: "high" as const,
  thinkingLevels: ["low", "medium", "high"] as const,
  onModelChange: vi.fn().mockResolvedValue(undefined),
  onThinkingChange: vi.fn().mockResolvedValue(undefined),
};

describe("Composer", () => {
  it("uses the spacious composer shell and rounded input", () => {
    const { container } = render(<Composer {...controls} thinkingLevels={[...controls.thinkingLevels]} status="ready" imageInput onSend={vi.fn()} onAbort={vi.fn()} />);
    expect(screen.getByTestId("composer-input")).toHaveClass("composer-input", "rounded-xl", "border-border");
    expect(screen.getByLabelText("向 Pi Chat 提问")).toHaveClass("min-h-14", "text-sm");
    expect(container.querySelector('[data-slot="composer-shell"]')).toHaveClass("pt-2", "md:pb-5");
    expect(container.querySelector('[data-slot="composer-shell"]')).not.toHaveClass("border-t");
  });

  it("defaults running messages to follow-up and allows switching to steer", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer {...controls} thinkingLevels={[...controls.thinkingLevels]} status="running" imageInput onSend={onSend} onAbort={vi.fn()} />);

    expect(screen.getByRole("button", { name: "选择消息投递方式，当前 Follow-up" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Follow-up/i), { target: { value: "continue this" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("continue this", [], "followUp"));

    fireEvent.change(screen.getByPlaceholderText(/Follow-up/i), { target: { value: "adjust this" } });
    fireEvent.pointerDown(screen.getByRole("button", { name: "选择消息投递方式，当前 Follow-up" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Steer/ }));
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("adjust this", [], "steer"));
  });

  it("shows queued messages with their delivery behavior while running", () => {
    render(<Composer
      {...controls}
      thinkingLevels={[...controls.thinkingLevels]}
      status="running"
      imageInput
      queue={{ steering: ["改用深色主题"], followUp: ["再补充测试"] }}
      onSend={vi.fn()}
      onAbort={vi.fn()}
    />);

    const queue = screen.getByTestId("queued-messages");
    expect(queue).toHaveTextContent("改用深色主题");
    expect(queue).toHaveTextContent("Steer");
    expect(queue).toHaveTextContent("再补充测试");
    expect(queue).toHaveTextContent("Follow-up");
  });

  it("blocks new messages while compacting", () => {
    render(<Composer {...controls} thinkingLevels={[...controls.thinkingLevels]} status="compacting" imageInput onSend={vi.fn()} onAbort={vi.fn()} />);
    expect(screen.getByPlaceholderText("正在压缩上下文…")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /选择消息投递方式/ })).not.toBeInTheDocument();
  });

  it("keeps the draft when sending fails", async () => {
    render(<Composer {...controls} thinkingLevels={[...controls.thinkingLevels]} status="ready" imageInput onSend={vi.fn().mockRejectedValue(new Error("failed"))} onAbort={vi.fn()} />);
    const input = screen.getByPlaceholderText("向 Pi Chat 提问…");
    fireEvent.change(input, { target: { value: "retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    expect(input).toHaveValue("retry me");
  });

  it("places image previews inside the composer and removes them", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    render(<Composer {...controls} thinkingLevels={[...controls.thinkingLevels]} status="ready" imageInput onSend={vi.fn()} onAbort={vi.fn()} />);
    const image = new File(["image"], "screen.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("选择附件"), { target: { files: [image] } });

    const tray = screen.getByTestId("attachment-tray");
    expect(screen.getByTestId("composer-input")).toContainElement(tray);
    expect(screen.getByRole("img", { name: "screen.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除 screen.png" }));
    expect(screen.queryByTestId("attachment-tray")).not.toBeInTheDocument();
  });

  it("accepts and submits arbitrary files", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer {...controls} thinkingLevels={[...controls.thinkingLevels]} status="ready" imageInput={false} onSend={onSend} onAbort={vi.fn()} />);
    const input = screen.getByLabelText("选择附件");
    const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });
    expect(input).not.toHaveAttribute("accept");
    fireEvent.change(input, { target: { files: [pdf] } });
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("", [pdf], "followUp"));
  });

  it("keeps permission, model, and thinking controls in the composer toolbar", () => {
    render(<Composer {...controls} thinkingLevels={[...controls.thinkingLevels]} status="ready" imageInput onSend={vi.fn()} onAbort={vi.fn()} />);
    expect(screen.getByRole("button", { name: "权限：本机完整权限" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模型 GPT-5.6 Sol，思考深度 High" })).toHaveClass("focus-visible:ring-0");
  });

  it("switches model and thinking depth from cascading menus", async () => {
    const onModelChange = vi.fn().mockResolvedValue(undefined);
    const onThinkingChange = vi.fn().mockResolvedValue(undefined);
    render(<Composer
      {...controls}
      models={[...controls.models, { ...controls.models[0], id: "gpt-5.6-terra", name: "GPT-5.6 Terra" }]}
      thinkingLevels={[...controls.thinkingLevels]}
      status="ready"
      imageInput
      onSend={vi.fn()}
      onAbort={vi.fn()}
      onModelChange={onModelChange}
      onThinkingChange={onThinkingChange}
    />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "模型 GPT-5.6 Sol，思考深度 High" }), { button: 0, ctrlKey: false });
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "选择模型，当前 GPT-5.6 Sol" }), { pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "5.6 Terra" }));
    expect(onModelChange).toHaveBeenCalledWith("openai", "gpt-5.6-terra");

    fireEvent.pointerDown(screen.getByRole("button", { name: "模型 GPT-5.6 Sol，思考深度 High" }), { button: 0, ctrlKey: false });
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "选择思考深度，当前 High" }), { pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Light" }));
    expect(onThinkingChange).toHaveBeenCalledWith("low");
  });
});
