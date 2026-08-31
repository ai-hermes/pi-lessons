import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  LoaderCircle,
  XCircle,
} from "lucide-react";
import type { ToolRun } from "../../shared/types";

export function ToolCard({ tool }: { tool: ToolRun }) {
  const [open, setOpen] = useState(false);
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
      <button className="tool-summary" onClick={() => setOpen(!open)}>
        <FileText size={16} />
        <strong>{tool.name}</strong>
        <span>{tool.result ?? "工具调用"}</span>
        {statusIcon}
        {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
      </button>
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
