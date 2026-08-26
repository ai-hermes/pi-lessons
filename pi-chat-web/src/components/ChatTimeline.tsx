import { Children, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownIcon, BrainCircuitIcon, CheckIcon, ChevronRightIcon, CopyIcon, FilesIcon, GitBranchIcon, HistoryIcon, LoaderCircleIcon, PencilIcon, TerminalSquareIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChatMessage, ThinkingBlock, ToolRun } from "../../shared/types";
import { PiLogo } from "./PiLogo";
import { RunGroup } from "./RunGroup";

interface Props {
  conversationId?: string;
  showWelcome?: boolean;
  messages: ChatMessage[];
  tools: ToolRun[];
  thinking?: ThinkingBlock[];
  onBranch(entryId: string, text: string): Promise<void>;
}

export function ChatTimeline({ conversationId, showWelcome = false, messages, tools, thinking = [], onBranch }: Props) {
  const [branchMessage, setBranchMessage] = useState<ChatMessage>();
  const [branchText, setBranchText] = useState("");
  const [branching, setBranching] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const timeline = useMemo(() => groupTimeline(messages, tools, thinking), [messages, tools, thinking]);
  const contentVersion = `${timeline.length}:${messages.at(-1)?.text.length ?? 0}:${messages.at(-1)?.streaming ?? false}:${tools.at(-1)?.status ?? ""}:${tools.at(-1)?.result?.length ?? 0}:${thinking.at(-1)?.text.length ?? 0}`;

  const viewport = () => rootRef.current?.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
  const jumpToLatest = (behavior: ScrollBehavior = "smooth") => {
    const element = viewport();
    if (!element) return;
    if (typeof element.scrollTo === "function") element.scrollTo({ top: element.scrollHeight, behavior });
    else element.scrollTop = element.scrollHeight;
    following.current = true;
    setShowLatest(false);
  };

  useEffect(() => {
    const element = viewport();
    if (!element) return undefined;
    const onScroll = () => {
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      following.current = nearBottom;
      setShowLatest(!nearBottom);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [conversationId]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useLayoutEffect(() => {
    following.current = true;
    const frame = requestAnimationFrame(() => jumpToLatest("auto"));
    return () => cancelAnimationFrame(frame);
  }, [conversationId]);

  useLayoutEffect(() => {
    if (!following.current) return undefined;
    const frame = requestAnimationFrame(() => jumpToLatest("auto"));
    return () => cancelAnimationFrame(frame);
  }, [contentVersion]);

  const branch = async () => {
    if (!branchMessage || !branchText.trim()) return;
    setBranching(true);
    try { await onBranch(branchMessage.id, branchText); setBranchMessage(undefined); }
    finally { setBranching(false); }
  };

  return <>
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollArea ref={rootRef} className="min-h-0 flex-1">
        <div data-slot="timeline-content" className={cn("mx-auto flex w-full min-w-0 max-w-[min(60rem,100dvw)] flex-col px-3 py-4 sm:px-4 md:px-6 md:py-5", showLatest && "pb-14 md:pb-14")}>
          {showWelcome ? <WelcomeState /> : timeline.length > 0 ? <div className="flex min-w-0 flex-col">
            {timeline.map((item) => item.kind === "run"
              ? <div key={`run-${item.tools[0]?.id}`} data-slot="run-group-row" className="min-w-0 py-0.5"><RunGroup tools={item.tools} /></div>
              : item.kind === "thinking"
                ? <ThinkingNode key={item.thinking.id} thinking={item.thinking} />
                : <MessageRow key={item.message.id} message={item.message} now={now} onBranch={() => { setBranchMessage(item.message); setBranchText(item.message.text); }} />)}
            {messages.some((message) => message.role === "assistant" && message.streaming) && <ReplyingIndicator />}
          </div> : null}
        </div>
      </ScrollArea>
      {showLatest && <div data-slot="jump-latest" className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
        <Button className="pointer-events-auto border bg-background" variant="outline" size="sm" onClick={() => jumpToLatest()}>
          <ArrowDownIcon data-icon="inline-start" />回到最新
        </Button>
      </div>}
    </div>

    <Dialog open={Boolean(branchMessage)} onOpenChange={(open) => { if (!open) setBranchMessage(undefined); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑消息并创建分支</DialogTitle>
          <DialogDescription>新分支保留此消息之前的上下文，并与原对话共享当前 workspace。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="branch-message">消息</FieldLabel>
            <Textarea id="branch-message" value={branchText} onChange={(event) => setBranchText(event.target.value)} rows={6} />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => setBranchMessage(undefined)}>取消</Button>
          <Button onClick={() => { branch().catch(() => undefined); }} disabled={!branchText.trim() || branching}>
            <GitBranchIcon data-icon="inline-start" />{branching ? "创建中" : "创建分支"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function WelcomeState() {
  return <Empty data-slot="welcome-empty" className="relative min-h-[58vh] overflow-hidden border-0 px-3 py-10 sm:px-6">
    <div className="relative z-10 flex w-full max-w-3xl flex-col items-center">
      <EmptyHeader className="max-w-2xl gap-2.5">
        <EmptyMedia className="mb-1 size-11 rounded-md bg-primary text-primary-foreground shadow-sm"><PiLogo className="size-6" /></EmptyMedia>
        <p className="text-xs font-medium text-muted-foreground">Pi agent harness</p>
        <EmptyTitle className="text-2xl font-semibold tracking-[-0.025em] sm:text-[1.75rem]">交给 Pi 来完成</EmptyTitle>
        <EmptyDescription className="max-w-xl text-sm leading-6 text-body">描述目标，Pi 会读取工作区、运行命令并修改文件。工具过程与结果会保留在同一条时间线中。</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="mt-8 grid w-full max-w-none grid-cols-1 gap-0 border-y text-left sm:grid-cols-3">
        <CapabilityItem icon={FilesIcon} title="文件系统" description="读取、编辑和写入当前工作区" />
        <CapabilityItem icon={TerminalSquareIcon} title="Shell" description="运行命令并持续回传输出" divided />
        <CapabilityItem icon={HistoryIcon} title="持久会话" description="恢复、分支与压缩上下文" divided />
      </EmptyContent>
    </div>
  </Empty>;
}

function MessageRow({ message, now, onBranch }: { message: ChatMessage; now: number; onBranch(): void }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const copy = async () => {
    await navigator.clipboard.writeText(message.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return <article className={cn("group/message flex py-1", isUser ? "justify-end" : "justify-start")}>
    <div className={cn("relative min-w-0 max-w-[92%] sm:max-w-[84%] md:max-w-[80%]", isUser && "w-fit")}>
      <div data-slot="message-bubble" className={cn(
        "min-w-0 border text-sm leading-6",
        isUser ? "rounded-2xl border-transparent bg-muted px-3 py-2" : "rounded-md border-transparent bg-transparent px-0 py-2",
      )}>
      {message.images.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{message.images.map((image, index) => <img key={index} alt="用户附件" src={`data:${image.mimeType};base64,${image.data}`} className="max-h-56 rounded-lg border object-contain" />)}</div>}
      {message.text && <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        h1: ({ children }) => <h1 className="mb-1.5 mt-4 text-lg first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-1 mt-3 text-base first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1 mt-2.5 text-sm">{children}</h3>,
        p: ({ children }) => <p className="mb-2 [overflow-wrap:anywhere] leading-6 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc pl-5 leading-6">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 leading-6">{children}</ol>,
        blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
        table: ({ children }) => <div className="mb-2.5 overflow-auto rounded-md border bg-card"><table className="w-full text-sm">{children}</table></div>,
        th: ({ children }) => <th className="border-b bg-muted px-2.5 py-1.5 text-left font-medium">{children}</th>,
        td: ({ children }) => <td className="border-b px-2.5 py-1.5 align-top last:border-r-0">{children}</td>,
        code: ({ className, children }) => <code className={cn(className ? "font-mono" : "rounded-sm bg-muted px-1 py-0.5 font-mono text-xs", className)}>{children}</code>,
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-link underline underline-offset-4">{children}</a>,
      }}>{message.text}</ReactMarkdown>}
      {message.pending && !message.text && <p className="text-sm text-muted-foreground">正在发送图片…</p>}
      {message.error && <p className="mt-2 text-sm text-destructive [overflow-wrap:anywhere]">{message.error}</p>}
      </div>
      <div data-slot="message-meta" className={cn("flex min-h-5 items-center gap-1 text-xs text-muted-foreground md:opacity-0 md:transition-opacity md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100", isUser ? "justify-end" : "justify-start")}>
        <time dateTime={new Date(message.timestamp).toISOString()}>{relativeTime(message.timestamp, now)}</time>
        {!message.streaming && message.text && <div data-slot="message-actions" className="flex gap-0.5">
          <Button variant="ghost" size="icon-xs" aria-label="复制消息" onClick={() => { copy().catch(() => undefined); }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button>
          {isUser && <Button variant="ghost" size="icon-xs" aria-label="编辑并创建分支" onClick={onBranch}><PencilIcon /></Button>}
        </div>}
      </div>
    </div>
  </article>;
}

function ReplyingIndicator() {
  return <div data-slot="replying-indicator" className="flex min-h-8 items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground" aria-label="生成中">
    <LoaderCircleIcon className="size-3 animate-spin" />正在回复
  </div>;
}

function ThinkingNode({ thinking }: { thinking: ThinkingBlock }) {
  return <Collapsible data-slot="thinking-node" className="group/thinking min-w-0 max-w-[92%] sm:max-w-[84%] md:max-w-[80%]">
    <CollapsibleTrigger className="flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs text-muted-foreground focus-visible:outline-none">
      <BrainCircuitIcon className="size-3.5 shrink-0" />
      <span className="font-medium">思考过程</span>
      <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/thinking:rotate-90" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <pre className="mx-2.5 mb-1 max-h-80 overflow-auto p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">{thinking.text}</pre>
    </CollapsibleContent>
  </Collapsible>;
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = nodeText(children).replace(/\n$/, "");
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return <div className="group/code relative mb-2.5 overflow-auto rounded-md border bg-surface-subtle p-3 font-mono text-xs leading-5">
    <Button variant="ghost" size="icon-xs" className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100" aria-label="复制代码块" onClick={() => { copy().catch(() => undefined); }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button>
    {children}
  </div>;
}

function CapabilityItem({ icon: Icon, title, description, divided = false }: { icon: typeof FilesIcon; title: string; description: string; divided?: boolean }) {
  return <div className={cn("grid min-w-0 grid-cols-[24px_minmax(0,1fr)] gap-2.5 px-3 py-4 sm:px-4", divided && "border-t sm:border-t-0 sm:border-l")}>
    <Icon className="mt-0.5 size-3.5 text-muted-foreground" />
    <div className="min-w-0"><p className="text-xs font-medium">{title}</p><p className="mt-1 text-[var(--type-meta)] leading-[var(--leading-meta)] text-muted-foreground">{description}</p></div>
  </div>;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return Children.toArray(node).map(nodeText).join("");
}

function relativeTime(timestamp: number, now: number): string {
  const elapsed = now - timestamp;
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

type TimelineEntry =
  | { kind: "message"; timestamp: number; message: ChatMessage }
  | { kind: "run"; timestamp: number; tools: ToolRun[] }
  | { kind: "thinking"; timestamp: number; thinking: ThinkingBlock };

export function groupTimeline(messages: ChatMessage[], tools: ToolRun[], thinking: ThinkingBlock[] = []): TimelineEntry[] {
  const ordered = [
    ...thinking.map((item) => ({ kind: "thinking" as const, timestamp: item.timestamp, thinking: item, order: 0 })),
    ...tools.map((tool) => ({ kind: "tool" as const, timestamp: tool.startedAt, tool, order: 1 })),
    ...messages.map((message) => ({ kind: "message" as const, timestamp: message.timestamp, message, order: 2 })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);

  return ordered.reduce<TimelineEntry[]>((entries, item) => {
    if (item.kind === "message") {
      entries.push(item);
      return entries;
    }
    if (item.kind === "thinking") {
      entries.push(item);
      return entries;
    }
    const previous = entries.at(-1);
    if (previous?.kind === "run") previous.tools.push(item.tool);
    else entries.push({ kind: "run", timestamp: item.timestamp, tools: [item.tool] });
    return entries;
  }, []);
}
