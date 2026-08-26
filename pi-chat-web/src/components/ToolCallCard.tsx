import { type ComponentType } from "react";
import {
  ChevronDownIcon, ChevronRightIcon, CircleCheckIcon, CircleXIcon, FilePenLineIcon, FileSearchIcon,
  FileTextIcon, FilesIcon, FolderOpenIcon, LoaderCircleIcon, SearchIcon, TerminalSquareIcon, WrenchIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolRun } from "../../shared/types";

type Details = { patch?: string; diff?: string; truncated?: boolean; path?: string };

export function ToolCallCard({ tool }: { tool: ToolRun }) {
  const details = tool.details as Details | undefined;
  const output = details?.patch || details?.diff || tool.result || (tool.details ? JSON.stringify(tool.details, null, 2) : "");
  const duration = tool.endedAt ? formatDuration(tool.endedAt - tool.startedAt) : undefined;
  const ToolIcon = toolIcon(tool.name);
  const StatusIcon = tool.status === "running" ? LoaderCircleIcon : tool.status === "error" ? CircleXIcon : CircleCheckIcon;

  return <Collapsible data-slot="tool-call-row" className="group/tool min-w-0 bg-card">
    <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none">
      <ToolIcon className={cn("size-3.5 shrink-0 text-muted-foreground", tool.status === "error" && "text-destructive")} />
      <span className="shrink-0 font-mono text-xs font-medium">{tool.name}</span>
      <Badge variant="ghost" className={cn("shrink-0 font-normal", tool.status === "error" ? "text-destructive" : tool.status === "success" ? "text-success" : "text-foreground")}>
        <StatusIcon data-icon="inline-start" className={cn(tool.status === "running" && "animate-spin")} />
        {tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "完成"}
      </Badge>
      {duration && <span className="font-mono text-xs tabular-nums text-muted-foreground">{duration}</span>}
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-[color,transform] group-hover/tool:translate-x-0.5 group-hover/tool:text-foreground group-data-[state=open]/tool:hidden" />
      <ChevronDownIcon className="hidden size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/tool:text-foreground group-data-[state=open]/tool:block" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="flex flex-col gap-2.5 px-2.5 py-1.5 pl-8 text-xs">
        <RawSection title="参数" output={JSON.stringify(tool.args, null, 2)} />
        {(details?.patch || details?.diff) && output
          ? <RawSection title="变更" output={output} />
          : output && <RawSection title={tool.status === "error" ? "错误输出" : "输出"} output={output} />}
        {details?.truncated && <p className="text-muted-foreground">输出已由 Pi 截断。</p>}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

function RawSection({ title, output }: { title: string; output: string }) {
  return <section className="w-full max-w-full self-start rounded-md border border-border/60 sm:w-[42rem]">
    <div className="flex h-8 items-center gap-2 px-2.5">
      <span className="font-mono text-xs font-medium">{title}</span>
    </div>
    <pre className="max-h-80 overflow-auto p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-all">{output}</pre>
  </section>;
}

function toolIcon(name: string): ComponentType<{ className?: string }> {
  return ({ bash: TerminalSquareIcon, edit: FilePenLineIcon, write: FilesIcon, read: FileTextIcon, grep: SearchIcon, find: FileSearchIcon, ls: FolderOpenIcon } as Record<string, ComponentType<{ className?: string }>>)[name] ?? WrenchIcon;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
