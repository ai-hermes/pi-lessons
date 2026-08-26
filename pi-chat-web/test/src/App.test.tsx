import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PermissionMenu } from "@/components/Composer";

describe("PermissionMenu", () => {
  it("exposes the single persistent local-permission warning", () => {
    render(<TooltipProvider><PermissionMenu /></TooltipProvider>);
    expect(screen.getByRole("button", { name: "权限：本机完整权限" })).toBeInTheDocument();
  });
});
