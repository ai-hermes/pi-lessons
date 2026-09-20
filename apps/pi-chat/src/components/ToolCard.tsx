import { Button } from "@components/ui/button";
import type { ToolRun } from "@shared/types";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  LoaderCircle,
  XCircle,
} from "lucide-react";
import { useState } from "react";

type ToolLabelDetails = Record<string, unknown> & {
  server?: string;
  tool?: string;
  mode?: string;
};

const mcpOperations = ["connect", "describe", "instructions", "list", "search", "status"] as const;
type McpOperation = (typeof mcpOperations)[number];
type ToolLabelArgs = ToolRun["args"] &
  Partial<Record<"server" | "tool" | "mode" | McpOperation, string>>;

function toolLabel(tool: ToolRun) {
  const details = (tool.details ?? {}) as ToolLabelDetails;
  const args = tool.args as ToolLabelArgs;
  const server = details.server ?? args.server;
  const calledTool = details.tool ?? args.tool;
  const mode = args.mode ?? details.mode;

  if (tool.name !== "mcp" && !tool.name.startsWith("mcp__")) {
    return tool.name;
  }

  const namespace = tool.name.startsWith("mcp__") ? tool.name.slice(5) : undefined;
  const source = server ?? namespace;

  if (mode && mcpOperations.includes(mode as McpOperation)) {
    return `${source || tool.name} / ${mode}`;
  }
  return [source, calledTool].filter(Boolean).join(" / ") || tool.name;
}

export function ToolCard({ tool }: { tool: ToolRun }) {
  const [open, setOpen] = useState(false);
  const label = toolLabel(tool);
  const statusIcon =
    tool.status === "running" ? (
      <LoaderCircle className="running" size={17} />
    ) : tool.status === "error" ? (
      <XCircle className="error" size={17} />
    ) : (
      <CheckCircle2 className="success" size={17} />
    );
  return (
    <div className="tool-card">
      <Button variant="ghost" className="tool-summary" onClick={() => setOpen(!open)}>
        <FileText size={16} />
        <strong title={label}>{label}</strong>
        {statusIcon}
        {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
      </Button>
      {open && (
        <div className="tool-details">
          <label>参数</label>
          <pre>{JSON.stringify(tool.args, null, 2)}</pre>
          {tool.result && (
            <>
              <label>输出</label>
              <pre>{tool.result}</pre>
            </>
          )}
          {tool.images?.map((image, index) =>
            /^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) ? (
              <img
                key={`${image.mimeType}:${image.data}`}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`${label} 截图 ${index + 1}`}
                className="tool-image"
              />
            ) : null,
          )}
          {tool.details !== undefined && (
            <>
              <label>详情</label>
              <pre>{JSON.stringify(tool.details, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
