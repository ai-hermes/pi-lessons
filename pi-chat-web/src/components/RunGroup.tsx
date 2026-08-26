import type { ToolRun } from "../../shared/types";
import { ToolCallCard } from "./ToolCallCard";

export function RunGroup({ tools }: { tools: ToolRun[] }) {
  return <div data-slot="run-steps">
    {tools.map((tool) => <ToolCallCard key={tool.id} tool={tool} />)}
  </div>;
}
