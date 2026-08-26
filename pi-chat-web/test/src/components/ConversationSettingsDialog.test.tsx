import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GlobalToolSettingsView } from "@shared/types";
import { ConversationSettingsDialog } from "@/components/ConversationSettingsDialog";
import { TooltipProvider } from "@/components/ui/tooltip";

const toolSettings: GlobalToolSettingsView = {
  defaultEnabled: true,
  tools: [{
    name: "web_search",
    description: "Search the web",
    source: { kind: "extension", label: "pi-web-access", path: "/node_modules/pi-web-access/index.ts" },
    enabled: true,
  }],
};

describe("ConversationSettingsDialog", () => {
  it("exposes global queue defaults and tool configuration", async () => {
    const onGlobalTool = vi.fn().mockResolvedValue(undefined);
    const onGlobalQueue = vi.fn().mockResolvedValue(undefined);
    render(<TooltipProvider><ConversationSettingsDialog
      open
      onOpenChange={vi.fn()}
      toolSettings={toolSettings}
      queueSettings={{ steeringMode: "all", followUpMode: "one-at-a-time" }}
      onGlobalTool={onGlobalTool}
      onGlobalQueue={onGlobalQueue}
    /></TooltipProvider>);

    expect(screen.getByRole("heading", { name: "全局设置" })).toBeInTheDocument();
    expect(screen.getByText("管理所有会话的默认运行策略和可用工具；会话级覆盖配置优先生效。")).toBeInTheDocument();
    expect(screen.getByText("pi-web-access")).toBeInTheDocument();
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();
    const toolsTab = screen.getByRole("tab", { name: "工具" });
    const queueTab = screen.getByRole("tab", { name: "运行策略" });
    expect(toolsTab).toHaveAttribute("data-state", "active");
    expect(queueTab).toHaveAttribute("data-state", "inactive");
    expect(queueTab.className).toContain("data-[state=active]:!bg-primary");
    expect(queueTab.className).toContain("data-[state=active]:!text-primary-foreground");
    expect(screen.queryByText("当前会话")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "web_search 全局状态" }));
    await waitFor(() => expect(onGlobalTool).toHaveBeenCalledWith("web_search", false));

    fireEvent.mouseDown(queueTab, { button: 0, ctrlKey: false });
    expect(toolsTab).toHaveAttribute("data-state", "inactive");
    expect(queueTab).toHaveAttribute("data-state", "active");
    expect(screen.getByLabelText("Steer 消费说明")).toBeInTheDocument();
    expect(screen.getByLabelText("Follow-up 消费说明")).toBeInTheDocument();
    expect(screen.getByText("下一轮把所有排队的 Steer 一起加入上下文，Agent 同时响应。")).toBeVisible();
    expect(screen.getByText("每轮只加入第一条，Agent 响应后再按顺序取下一条。")).toBeVisible();
    expect(screen.getByText("把所有排队的 Follow-up 一起加入下一轮上下文，Agent 合并处理。")).toBeVisible();
    expect(screen.getByText("每轮只处理第一条，完成响应后再按顺序处理下一条。")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Steer 消费（全局）：全部" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Follow-up 消费（全局）：逐条" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Steer 消费（全局）：逐条" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Follow-up 消费（全局）：全部" }));
    await waitFor(() => expect(onGlobalQueue).toHaveBeenCalledWith({ steeringMode: "one-at-a-time" }));
    await waitFor(() => expect(onGlobalQueue).toHaveBeenCalledWith({ followUpMode: "all" }));
  });
});
