import { useEffect, useState } from "react";
import {
  ActivityIcon, ArchiveIcon, ArrowUpIcon, BotIcon, CheckIcon, CircleIcon, CoinsIcon, CopyIcon, DownloadIcon, FolderIcon, GaugeIcon,
  RouteIcon, SparklesIcon, TimerResetIcon, WrenchIcon, XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ActivityItem, ConversationSettings, ConversationSettingsPatch, ConversationSnapshot, QueueMode, ToolSettingItem, ToolSettingsView } from "../../shared/types";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  snapshot: ConversationSnapshot;
  onCompact(instructions: string): Promise<void>;
  toolSettings?: ToolSettingsView;
  toolSettingsLoading?: boolean;
  onSettings(settings: ConversationSettingsPatch): Promise<void>;
  onConversationTool(name: string, enabled: boolean | null): Promise<void>;
}

export function HarnessSheet({ open, onOpenChange, snapshot, onCompact, toolSettings, toolSettingsLoading = false, onSettings, onConversationTool }: Props) {
  const [compactOpen, setCompactOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [sessionCopied, setSessionCopied] = useState(false);
  const usage = snapshot.stats.contextUsage;
  const base = `/api/conversations/${snapshot.conversation.id}`;
  const queueCount = snapshot.queue.steering.length + snapshot.queue.followUp.length;
  const copySessionId = async () => {
    await navigator.clipboard.writeText(snapshot.stats.sessionId);
    setSessionCopied(true);
    window.setTimeout(() => setSessionCopied(false), 1200);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open && !compactOpen) onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [compactOpen, onOpenChange, open]);

  return <>
    <aside
      aria-hidden={!open}
      aria-label="会话明细"
      className={cn(
        "fixed inset-y-0 right-0 z-40 h-dvh overflow-hidden border-l bg-background shadow-[-12px_0_32px_rgba(0,0,0,0.08)] transition-[width,border-color] duration-200 ease-out md:static md:shrink-0",
        open ? "w-full md:w-[32rem]" : "pointer-events-none w-0 border-l-transparent",
      )}
    >
      <div className={cn(
        "flex h-full w-[min(100vw,32rem)] flex-col transition-transform duration-200 ease-out",
        open ? "translate-x-0" : "translate-x-full",
      )}>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          <ActivityIcon className="size-4.5 shrink-0 text-muted-foreground" />
          <h2 className="text-sm font-medium">会话明细</h2>
          <Badge variant="outline" className={cn("w-fit gap-1.5 border-0 bg-transparent px-0 py-0 font-normal text-success shadow-none", snapshot.status === "error" && "text-destructive")}>
            <span className={cn("flex size-2 shrink-0", snapshot.status !== "error" && "animate-pulse")}>
              <CircleIcon className="size-full fill-current" />
            </span>
            <span className={cn("animate-none text-success", snapshot.status === "error" && "text-destructive")}>{statusLabel(snapshot.status)}</span>
          </Badge>
          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="关闭会话明细" onClick={() => onOpenChange(false)}>
            <XIcon />
          </Button>
        </header>
        <section aria-label="模型信息" className="shrink-0 border-b px-4 py-2.5 text-[var(--type-meta)] leading-[var(--leading-meta)]">
          <p className="mb-1 text-xs text-muted-foreground">查看 Pi session 的运行记录和上下文状态。</p>
          <div className="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-l-2 border-muted pl-2.5">
            <span className="text-muted-foreground">模型名</span>
            <span className="truncate font-mono text-foreground">{snapshot.model.provider}/{snapshot.model.id}</span>
            <span className="text-muted-foreground">思考强度{" "}</span>
            <span className="font-mono text-foreground">{snapshot.thinkingLevel}</span>
          </div>
        </section>
        <Tabs defaultValue="activity" className="min-h-0 flex-1 flex-col gap-0 overflow-hidden">
          <div className="shrink-0 border-b bg-background px-4 py-2">
            <TabsList className="grid h-9 w-full grid-cols-3">
              <OverviewTab value="activity" icon={ActivityIcon}>活动</OverviewTab>
              <OverviewTab value="context" icon={GaugeIcon}>上下文</OverviewTab>
              <OverviewTab value="settings" icon={WrenchIcon}>本会话配置</OverviewTab>
            </TabsList>
          </div>
          <ScrollArea className="min-h-0 w-full flex-1 overflow-hidden">
            <TabsContent value="activity" className="mt-0 flex flex-col gap-3 p-3.5">
              {queueCount > 0 && <section className="flex flex-col gap-2">
                <SectionHeading title="消息队列" value={String(queueCount)} />
                <QueueList label="Steer" items={snapshot.queue.steering} />
                <QueueList label="Follow-up" items={snapshot.queue.followUp} />
              </section>}
              {queueCount > 0 && <Separator />}
              <section className="flex flex-col gap-2">
                <SectionHeading title="运行时间线" value={snapshot.activity.length ? `${snapshot.activity.length} 条` : undefined} />
                {snapshot.activity.length === 0
                  ? <Empty className="min-h-40 rounded-lg border border-dashed bg-card py-6"><EmptyHeader><EmptyMedia variant="icon"><ActivityIcon /></EmptyMedia><EmptyTitle>尚无运行事件</EmptyTitle><EmptyDescription>模型响应、工具调用和设置变化会实时出现在这里。</EmptyDescription></EmptyHeader></Empty>
                  : <div data-slot="activity-list" className="overflow-hidden rounded-md border bg-card">{snapshot.activity.map((item, index) => <ActivityRow key={`${item.id}-${item.type}`} item={item} active={snapshot.status === "running" && index === 0} last={index === snapshot.activity.length - 1} />)}</div>}
              </section>
            </TabsContent>
            <TabsContent value="context" className="mt-0 flex flex-col gap-4 p-4">
              <section className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div><p className="text-sm font-medium">上下文用量</p><p className="mt-1 text-xs text-muted-foreground">当前会话占模型窗口的比例</p></div>
                  <span className="font-mono text-lg font-semibold tabular-nums">{usage ? `${usage.percent.toFixed(1)}%` : "—"}</span>
                </div>
                <Progress value={usage?.percent ?? 0} className="h-2" />
                <p className="font-mono text-[var(--type-meta)] leading-[var(--leading-meta)] text-muted-foreground">{usage ? `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens` : "完成一次模型调用后显示。"}</p>
              </section>
              <section className="text-sm">
                <SectionHeading title="会话统计" />
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  <Metric icon={SparklesIcon} label="输入 tokens" value={snapshot.stats.tokens.input.toLocaleString()} />
                  <Metric icon={BotIcon} label="输出 tokens" value={snapshot.stats.tokens.output.toLocaleString()} />
                  <Metric icon={TimerResetIcon} label="缓存读取" value={snapshot.stats.tokens.cacheRead.toLocaleString()} />
                  <Metric icon={WrenchIcon} label="工具调用" value={String(snapshot.stats.toolCalls)} />
                  <Metric icon={CoinsIcon} label="估算费用" value={`$${snapshot.stats.cost.toFixed(4)}`} />
                </div>
              </section>
              <section>
                <SectionHeading title="上下文操作" />
                <div className="mt-2.5 grid grid-cols-2 gap-2"><Button className="col-span-2" size="sm" onClick={() => setCompactOpen(true)}><ArchiveIcon data-icon="inline-start" />压缩上下文</Button><Button variant="outline" size="sm" asChild><a href={`${base}/export?format=jsonl`}><DownloadIcon data-icon="inline-start" />导出 JSONL</a></Button><Button variant="outline" size="sm" asChild><a href={`${base}/export?format=html`}><DownloadIcon data-icon="inline-start" />导出 HTML</a></Button></div>
              </section>
              <section className="border-t pt-4">
                <div className="flex items-center gap-2">
                  <p className="flex items-center gap-2 text-xs font-medium"><FolderIcon className="size-4 text-muted-foreground" />Workspace</p>
                  <Button variant="ghost" size="icon-xs" aria-label="复制 Session ID" title={sessionCopied ? "已复制 Session ID" : "复制 Session ID"} onClick={() => { copySessionId().catch(() => undefined); }}>
                    {sessionCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
                  </Button>
                </div>
                <code className="mt-2 block break-all rounded-md bg-muted px-2.5 py-2 text-xs leading-4 text-foreground/80">{snapshot.conversation.workspace}</code>
              </section>
              {snapshot.diagnostics.length > 0 && <Alert><AlertTitle>Runtime diagnostics</AlertTitle><AlertDescription className="whitespace-pre-wrap">{snapshot.diagnostics.join("\n")}</AlertDescription></Alert>}
            </TabsContent>
            <TabsContent value="settings" className="mt-0 flex flex-col gap-4 p-4">
              <SessionSettingsPanel
                settings={snapshot.settings}
                toolSettings={toolSettings}
                loading={toolSettingsLoading}
                onSettings={onSettings}
                onConversationTool={onConversationTool}
              />
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </div>
    </aside>

    <Dialog open={compactOpen} onOpenChange={setCompactOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>压缩上下文</DialogTitle><DialogDescription>Pi 会把较早内容汇总为可恢复的 compaction entry。指令可留空。</DialogDescription></DialogHeader>
        <FieldGroup><Field><FieldLabel htmlFor="compact-instructions">自定义摘要指令</FieldLabel><Textarea id="compact-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} placeholder="例如：保留所有文件路径和未完成事项" /></Field></FieldGroup>
        <DialogFooter><Button variant="outline" onClick={() => setCompactOpen(false)}>取消</Button><Button onClick={() => { onCompact(instructions).then(() => setCompactOpen(false)).catch(() => undefined); }}>开始压缩</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function SessionSettingsPanel({
  settings,
  toolSettings,
  loading,
  onSettings,
  onConversationTool,
}: {
  settings: ConversationSettings;
  toolSettings?: ToolSettingsView;
  loading: boolean;
  onSettings(settings: ConversationSettingsPatch): Promise<void>;
  onConversationTool(name: string, enabled: boolean | null): Promise<void>;
}) {
  return <div className="space-y-5">
    <section className="rounded-lg border bg-card p-3">
      <SectionHeading title="会话策略" />
      <p className="mt-1 text-xs text-muted-foreground">只影响当前会话，不会修改全局设置。</p>
      <div className="mt-3 divide-y">
        <SessionSwitch label="自动压缩" checked={settings.autoCompaction} onChange={(autoCompaction) => onSettings({ autoCompaction })} />
        <SessionSwitch label="自动重试" checked={settings.autoRetry} onChange={(autoRetry) => onSettings({ autoRetry })} />
      </div>
    </section>
    <section className="rounded-lg border bg-card p-3">
      <SectionHeading title="队列消费" />
      <p className="mt-1 text-xs text-muted-foreground">决定运行中收到的 Steer 和 Follow-up 消息按批还是逐条处理。</p>
      <div className="mt-3 divide-y">
        <QueueModeField
          kind="steer"
          globalValue={settings.queueDefaults?.steeringMode ?? settings.steeringMode}
          override={settings.queueOverrides?.steeringMode ?? null}
          onChange={(steeringMode) => onSettings({ queueOverrides: { steeringMode } })}
        />
        <QueueModeField
          kind="followUp"
          globalValue={settings.queueDefaults?.followUpMode ?? settings.followUpMode}
          override={settings.queueOverrides?.followUpMode ?? null}
          onChange={(followUpMode) => onSettings({ queueOverrides: { followUpMode } })}
        />
      </div>
    </section>
    <section className="rounded-lg border bg-card p-3">
      <SectionHeading title="工具覆盖" />
      <p className="mt-1 text-xs text-muted-foreground">直接启用或禁用当前会话的工具，不会修改全局设置。</p>
      {loading && !toolSettings
        ? <p className="py-8 text-center text-xs text-muted-foreground">正在加载会话工具…</p>
        : !toolSettings
          ? <p className="py-8 text-center text-xs text-muted-foreground">会话工具配置加载失败。</p>
          : <div className="mt-3 divide-y border-t">{toolSettings.tools.map((tool) => <ConversationToolRow key={tool.name} tool={tool} onChange={onConversationTool} />)}</div>}
    </section>
  </div>;
}

function SessionSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): Promise<void> }) {
  const [saving, setSaving] = useState(false);
  return <label className="flex items-center justify-between gap-3 py-3 text-xs">
    <span>{label}</span>
    <Switch
      aria-label={`${label}（本会话）`}
      checked={checked}
      disabled={saving}
      onCheckedChange={(next) => {
        setSaving(true);
        onChange(next).catch(() => undefined).finally(() => setSaving(false));
      }}
    />
  </label>;
}

function QueueModeField({
  kind,
  globalValue,
  override,
  onChange,
}: {
  kind: "steer" | "followUp";
  globalValue: QueueMode;
  override: QueueMode | null;
  onChange(value: QueueMode): Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const label = kind === "steer" ? "Steer 消费" : "Follow-up 消费";
  const Icon = kind === "steer" ? RouteIcon : ArrowUpIcon;
  const value = override ?? globalValue;
  return <div className="flex items-center justify-between gap-3 py-3">
    <div className="flex shrink-0 items-center gap-1.5 text-xs">
      <Icon className="size-3.5 text-muted-foreground" />
      <span>{label}</span>
    </div>
    <div
      role="group"
      aria-label={label}
      className="flex items-center justify-end gap-4"
    >
      <ModeCheckbox checked={value === "all"} disabled={saving} label={`${label}：全部`} tip="每轮一次性消费当前队列中的全部消息，适合将连续补充合并处理。" onSelect={() => selectMode("all")}>全部</ModeCheckbox>
      <ModeCheckbox checked={value === "one-at-a-time"} disabled={saving} label={`${label}：逐条`} tip="每轮只消费队列中的一条消息，保留消息之间的执行边界。" onSelect={() => selectMode("one-at-a-time")}>逐条</ModeCheckbox>
    </div>
  </div>;

  function selectMode(next: QueueMode): void {
    if (next === value) return;
    setSaving(true);
    onChange(next).catch(() => undefined).finally(() => setSaving(false));
  }
}

function ModeCheckbox({
  checked,
  disabled,
  label,
  tip,
  onSelect,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  tip: string;
  onSelect(): void;
  children: React.ReactNode;
}) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <label className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs hover:bg-accent/60">
        <Checkbox checked={checked} disabled={disabled} aria-label={label} onCheckedChange={(next) => { if (next === true) onSelect(); }} />
        <span>{children}</span>
      </label>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-64 leading-4">{tip}</TooltipContent>
  </Tooltip>;
}

function ConversationToolRow({ tool, onChange }: { tool: ToolSettingItem; onChange(name: string, enabled: boolean | null): Promise<void> }) {
  const [saving, setSaving] = useState(false);
  return <div className="grid gap-2 py-3">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><code className="text-xs font-medium">{tool.name}</code><span className="text-[11px] text-muted-foreground">{tool.effectiveEnabled ? "已启用" : "已禁用"}</span></div>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">{tool.description}</p>
      </div>
      <Switch
        checked={tool.effectiveEnabled}
        disabled={saving}
        aria-label={`${tool.name}（本会话）`}
        onCheckedChange={(enabled) => {
          setSaving(true);
          onChange(tool.name, enabled).catch(() => undefined).finally(() => setSaving(false));
        }}
      />
    </div>
    <p className="text-[11px] text-muted-foreground">全局：{tool.globalEnabled ? "已启用" : "已禁用"} · 当前生效：{tool.effectiveEnabled ? "已启用" : "已禁用"}</p>
  </div>;
}

function OverviewTab({ value, icon: Icon, children }: { value: string; icon: typeof ActivityIcon; children: string }) {
  return <TabsTrigger value={value} className="h-full gap-2 border border-transparent text-xs font-medium text-muted-foreground data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"><Icon />{children}</TabsTrigger>;
}

function ActivityRow({ item, active, last }: { item: ActivityItem; active: boolean; last: boolean }) {
  return <div data-slot="activity-row" className={cn("flex items-center gap-2.5 px-3 py-2", !last && "border-b")}>
    <CircleIcon className={cn("size-2.5 shrink-0 text-muted-foreground", active && "fill-success text-success")} />
    <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{activityLabel(item)}</p><p className="mt-0.5 truncate text-[var(--type-meta)] leading-[var(--leading-meta)] text-muted-foreground">{item.summary}</p></div>
    <time className="shrink-0 font-mono text-[11px] leading-4 tabular-nums text-muted-foreground">{new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
  </div>;
}

function QueueList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return <div className="border-l-2 bg-surface-subtle px-3 py-2"><p className="text-[var(--type-meta)] font-medium leading-[var(--leading-meta)] text-muted-foreground">{label}</p>{items.map((item, index) => <p key={`${label}-${index}`} className="mt-1 truncate text-xs">{item}</p>)}</div>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof ActivityIcon; label: string; value: string }) {
  return <div className="rounded-md border bg-card px-2.5 py-2"><div className="flex items-center gap-1.5 text-[var(--type-meta)] leading-[var(--leading-meta)] text-muted-foreground"><Icon className="size-3.5 shrink-0" />{label}</div><p className="mt-1 font-mono text-xs font-medium tabular-nums">{value}</p></div>;
}

function SectionHeading({ title, value }: { title: string; value?: string }) {
  return <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-medium">{title}</h3>{value && <span className="font-mono text-[var(--type-meta)] leading-[var(--leading-meta)] text-muted-foreground">{value}</span>}</div>;
}

function statusLabel(status: ConversationSnapshot["status"]): string {
  return ({ ready: "就绪", running: "运行中", stopping: "停止中", compacting: "压缩中", error: "错误", cold: "已释放" })[status];
}

function activityLabel(item: ActivityItem): string {
  return ({
    "message.started": "开始生成回复", "message.completed": "回复生成完成", "message.added": "消息已加入会话",
    "tool.started": "工具开始执行", "tool.updated": "工具输出更新", "tool.completed": "工具执行完成",
    "queue.updated": "消息队列已更新", "runtime.status": "运行状态已变化", "runtime.error": "运行时错误",
    "model.changed": "模型已切换", "thinking.changed": "Thinking 已切换", "settings.changed": "设置已更新",
    "compaction.started": "开始压缩上下文", "compaction.completed": "上下文压缩完成", "retry.started": "正在自动重试",
  } as Record<string, string>)[item.type] ?? item.summary;
}
