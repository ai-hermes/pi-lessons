import { useState } from "react";
import { ArrowUpIcon, InfoIcon, RouteIcon, Settings2Icon, SlidersHorizontalIcon, WrenchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { GlobalQueueSettings, GlobalToolSettingItem, GlobalToolSettingsView, QueueMode } from "../../shared/types";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  toolSettings?: GlobalToolSettingsView;
  queueSettings?: GlobalQueueSettings;
  toolSettingsLoading?: boolean;
  onGlobalTool(name: string, enabled: boolean): Promise<void>;
  onGlobalQueue(settings: Partial<GlobalQueueSettings>): Promise<void>;
}

export function ConversationSettingsDialog({
  open,
  onOpenChange,
  toolSettings,
  queueSettings,
  toolSettingsLoading = false,
  onGlobalTool,
  onGlobalQueue,
}: Props) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[min(680px,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
      <DialogHeader className="gap-1 border-b px-6 py-5 pr-12">
        <DialogTitle>全局设置</DialogTitle>
        <DialogDescription className="text-xs">管理所有会话的默认运行策略和可用工具；会话级覆盖配置优先生效。</DialogDescription>
      </DialogHeader>
      <Tabs defaultValue="tools" orientation="vertical" className="min-h-0 flex-1 flex-col gap-0 sm:flex-row">
        <TabsList className="w-full shrink-0 justify-start gap-1 rounded-none border-b bg-surface-subtle p-2 sm:h-full sm:w-52 sm:flex-col sm:items-stretch sm:justify-start sm:border-r sm:border-b-0 sm:p-3">
          <TabsTrigger value="tools" className="h-9 justify-start px-3 text-xs hover:bg-accent/60 data-[state=active]:!bg-primary data-[state=active]:!text-primary-foreground data-[state=active]:shadow-sm sm:flex-none">
            <Settings2Icon className="size-4" />
            工具
          </TabsTrigger>
          <TabsTrigger value="queue" className="h-9 justify-start px-3 text-xs hover:bg-accent/60 data-[state=active]:!bg-primary data-[state=active]:!text-primary-foreground data-[state=active]:shadow-sm sm:flex-none">
            <SlidersHorizontalIcon className="size-4" />
            运行策略
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tools" className="min-h-0 overflow-y-auto p-5 sm:p-6">
          <ToolSettingsPanel
            settings={toolSettings}
            loading={toolSettingsLoading}
            onGlobalTool={onGlobalTool}
          />
        </TabsContent>
        <TabsContent value="queue" className="min-h-0 overflow-y-auto p-5 sm:p-6">
          <QueueSettingsPanel settings={queueSettings} loading={toolSettingsLoading} onChange={onGlobalQueue} />
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>;
}

function QueueSettingsPanel({
  settings,
  loading,
  onChange,
}: {
  settings?: GlobalQueueSettings;
  loading: boolean;
  onChange(settings: Partial<GlobalQueueSettings>): Promise<void>;
}) {
  if (loading && !settings) return <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">正在加载运行策略…</div>;
  if (!settings) return <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">运行策略加载失败。</div>;
  return <div className="mx-auto max-w-4xl space-y-4">
    <p className="text-xs text-muted-foreground">这里设置所有会话的默认队列消费模式。单个会话选择覆盖值后，将优先使用会话配置。</p>
    <SettingSection icon={SlidersHorizontalIcon} title="队列消费" tip="控制运行中收到的 Steer 和 Follow-up 消息如何进入 Agent 循环。">
      <div className="divide-y px-3">
        <GlobalQueueModeField kind="steer" value={settings.steeringMode} onChange={(steeringMode) => onChange({ steeringMode })} />
        <GlobalQueueModeField kind="followUp" value={settings.followUpMode} onChange={(followUpMode) => onChange({ followUpMode })} />
      </div>
    </SettingSection>
  </div>;
}

function GlobalQueueModeField({
  kind,
  value,
  onChange,
}: {
  kind: "steer" | "followUp";
  value: QueueMode;
  onChange(value: QueueMode): Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const label = kind === "steer" ? "Steer 消费" : "Follow-up 消费";
  const Icon = kind === "steer" ? RouteIcon : ArrowUpIcon;
  const description = kind === "steer"
    ? {
        intro: "在当前运行中追加方向。",
        all: "下一轮把所有排队的 Steer 一起加入上下文，Agent 同时响应。",
        oneAtATime: "每轮只加入第一条，Agent 响应后再按顺序取下一条。",
        example: "例如连续发送“改成 TypeScript”“补测试”“不要改 API”。",
      }
    : {
        intro: "在当前运行结束后继续处理消息。",
        all: "把所有排队的 Follow-up 一起加入下一轮上下文，Agent 合并处理。",
        oneAtATime: "每轮只处理第一条，完成响应后再按顺序处理下一条。",
        example: "例如连续发送“补测试”“生成总结”“提交修改”。",
      };
  return <div className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs">
        <Tooltip>
          <TooltipTrigger asChild><Icon className="size-3.5 cursor-help text-muted-foreground" aria-label={`${label}说明`} /></TooltipTrigger>
          <TooltipContent side="top" className="max-w-80 space-y-1 leading-4">
            <p>{description.intro}</p>
            <p>{description.example}</p>
            <p><strong>全部：</strong>{description.all}</p>
            <p><strong>逐条：</strong>{description.oneAtATime}</p>
          </TooltipContent>
        </Tooltip>
        <span>{label}</span>
        <span className="text-muted-foreground">{description.intro}</span>
      </div>
      <div className="mt-1 space-y-0.5 pl-5 text-[11px] leading-4 text-muted-foreground">
        <p>{description.example}</p>
        <p><span className="font-medium text-foreground/80">全部：</span>{description.all}</p>
        <p><span className="font-medium text-foreground/80">逐条：</span>{description.oneAtATime}</p>
      </div>
    </div>
    <div
      role="group"
      aria-label={`${label}（全局）`}
      className="flex flex-wrap items-center justify-end gap-4 sm:flex-nowrap"
    >
      <QueueModeCheckbox
        checked={value === "all"}
        disabled={saving}
        label={`${label}（全局）：全部`}
        tip="每轮一次性消费当前队列中的全部消息，适合将连续补充合并处理。"
        onSelect={() => {
          if (value === "all") return;
          setSaving(true);
          onChange("all").catch(() => undefined).finally(() => setSaving(false));
        }}
      >
        全部
      </QueueModeCheckbox>
      <QueueModeCheckbox
        checked={value === "one-at-a-time"}
        disabled={saving}
        label={`${label}（全局）：逐条`}
        tip="每轮只消费一条消息，保留消息之间的执行边界。"
        onSelect={() => {
          if (value === "one-at-a-time") return;
          setSaving(true);
          onChange("one-at-a-time").catch(() => undefined).finally(() => setSaving(false));
        }}
      >
        逐条
      </QueueModeCheckbox>
    </div>
  </div>;
}

function QueueModeCheckbox({
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
      <label className="flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-accent/60">
        <Checkbox checked={checked} disabled={disabled} aria-label={label} onCheckedChange={(next) => { if (next === true) onSelect(); }} />
        <span>{children}</span>
      </label>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-64 leading-4">{tip}</TooltipContent>
  </Tooltip>;
}

function ToolSettingsPanel({
  settings,
  loading,
  onGlobalTool,
}: {
  settings?: GlobalToolSettingsView;
  loading: boolean;
  onGlobalTool(name: string, enabled: boolean): Promise<void>;
}) {
  if (loading && !settings) return <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">正在加载工具…</div>;
  if (!settings) return <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">工具配置加载失败。</div>;
  const groups = settings.tools.reduce<Record<string, GlobalToolSettingItem[]>>((result, tool) => {
    (result[tool.source.label] ??= []).push(tool);
    return result;
  }, {});
  return <div className="mx-auto max-w-4xl space-y-4">
    <p className="text-xs text-muted-foreground">新安装并注册的工具默认启用。此处仅管理全局状态，不包含任何单个会话的覆盖配置。</p>
    {Object.entries(groups).map(([label, tools]) => <SettingSection key={label} icon={WrenchIcon} title={label} tip="工具由服务端加载和执行。">
      <div className="divide-y px-3">
        {tools?.map((tool) => <ToolSettingRow key={tool.name} tool={tool} onGlobalTool={onGlobalTool} />)}
      </div>
    </SettingSection>)}
  </div>;
}

function ToolSettingRow({
  tool,
  onGlobalTool,
}: {
  tool: GlobalToolSettingItem;
  onGlobalTool(name: string, enabled: boolean): Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setSaving(true);
    try { await action(); }
    finally { setSaving(false); }
  };
  return <div className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <code className="truncate text-xs font-medium">{tool.name}</code>
        <Badge variant={tool.enabled ? "secondary" : "outline"}>{tool.enabled ? "已启用" : "已禁用"}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={tool.description}>{tool.description}</p>
    </div>
    <label className="flex items-center justify-between gap-2 text-xs sm:justify-start">
      <span>全局</span>
      <Switch
        aria-label={`${tool.name} 全局状态`}
        checked={tool.enabled}
        disabled={saving}
        onCheckedChange={(enabled) => { run(() => onGlobalTool(tool.name, enabled)).catch(() => undefined); }}
      />
    </label>
  </div>;
}

function SettingSection({ icon: Icon, title, tip, children }: { icon: typeof Settings2Icon; title: string; tip: string; children: React.ReactNode }) {
  return <section className="overflow-hidden rounded-md border"><div className="flex h-10 items-center gap-2 border-b bg-surface-subtle px-3"><Icon className="size-3.5 shrink-0 text-muted-foreground" /><h3 className="text-xs font-medium">{title}</h3><InfoTip label={`${title}说明`}>{tip}</InfoTip></div><div className="px-3">{children}</div></section>;
}

function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" className="size-4 rounded-full text-muted-foreground hover:text-foreground" aria-label={label}><InfoIcon className="size-3" /></Button></TooltipTrigger><TooltipContent side="top" sideOffset={6} className="max-w-64 leading-4">{children}</TooltipContent></Tooltip>;
}
