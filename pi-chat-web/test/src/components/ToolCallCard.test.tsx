import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallCard } from "@/components/ToolCallCard";

describe("ToolCallCard", () => {
  it("shows edit diff details", () => {
    render(<ToolCallCard tool={{ id: "1", name: "edit", args: { path: "app.ts" }, status: "success", details: { patch: "+hello" }, startedAt: 1, endedAt: 2 }} />);
    expect(screen.getByText("edit")).toBeInTheDocument();
    expect(screen.getByText("完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("参数")).toBeInTheDocument();
    expect(screen.getByText("+hello")).toBeInTheDocument();
    expect(screen.getByText("变更")).toBeInTheDocument();
  });

  it("shows bash output and exit status", () => {
    render(<ToolCallCard tool={{ id: "2", name: "bash", args: { command: "exit 7" }, status: "error", result: "Command exited with code 7", startedAt: 1, endedAt: 2 }} />);
    const trigger = screen.getByRole("button");
    expect(trigger).not.toHaveTextContent("$ exit 7");
    fireEvent.click(trigger);
    expect(screen.getByText(/"command": "exit 7"/)).toBeInTheDocument();
    expect(screen.getByText("Command exited with code 7")).toBeInTheDocument();
  });
});
