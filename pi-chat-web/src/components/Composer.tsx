import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, ChevronDownIcon, FileIcon, LoaderCircleIcon, OctagonIcon, PlusIcon, RouteIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuPortal,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import type { ModelOption, QueueBehavior, RuntimeStatus, ThinkingLevel } from "../../shared/types";

interface Props {
  status: RuntimeStatus;
  imageInput: boolean;
  models: ModelOption[];
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  queue?: { steering: string[]; followUp: string[] };
  onSend(text: string, files: File[], behavior: QueueBehavior): Promise<void>;
  onAbort(): Promise<void>;
  onModelChange(provider: string, id: string): Promise<void>;
  onThinkingChange(level: ThinkingLevel): Promise<void>;
}

export function Composer({
  status, imageInput, models, model, thinkingLevel, thinkingLevels, queue = { steering: [], followUp: [] },
  onSend, onAbort, onModelChange, onThinkingChange,
}: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [behavior, setBehavior] = useState<QueueBehavior>("followUp");
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = status === "running" || status === "stopping" || status === "compacting";
  const queueing = status === "running";
  const blocked = status === "stopping" || status === "compacting";
  const queued = queue.steering.length + queue.followUp.length;

  const submit = async () => {
    if ((!text.trim() && files.length === 0) || submitting || blocked) return;
    setSubmitting(true);
    try {
      await onSend(text, files, behavior);
      setText("");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
    } catch {
      // The parent reports the request error. Keep the draft so it can be retried.
    } finally { setSubmitting(false); }
  };

  const addFiles = (nextFiles: FileList | null) => {
    if (!nextFiles) return;
    setFiles((current) => [...current, ...[...nextFiles]].slice(0, 5));
  };

  return <div data-slot="composer-shell" className="shrink-0 bg-background px-2.5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2 md:px-4 md:pb-5">
    <div className="mx-auto w-full max-w-[60rem]">
      {queueing && queued > 0 && <QueuePreview queue={queue} />}
      <Field>
      <InputGroup data-testid="composer-input" className="composer-input h-auto rounded-xl border border-border bg-background transition-[border-color,box-shadow] duration-150 has-disabled:bg-background has-disabled:opacity-100">
        {files.length > 0 && <div data-testid="attachment-tray" className="flex w-full flex-wrap gap-2 px-3 pt-3">
          {files.map((file, index) => <AttachmentPreview
            key={`${file.name}-${file.lastModified}-${index}`}
            file={file}
            imageInput={imageInput}
            onRemove={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
          />)}
        </div>}
        <InputGroupTextarea
          aria-label="向 Pi Chat 提问"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit().catch(() => undefined); }
          }}
          placeholder={queueing ? `输入消息，将作为 ${queueBehaviorLabel(behavior)} 发送…` : status === "compacting" ? "正在压缩上下文…" : status === "stopping" ? "正在停止…" : "向 Pi Chat 提问…"}
          disabled={blocked}
          rows={1}
          className="max-h-40 min-h-14 px-3.5 pt-3 text-sm leading-6"
        />
        <InputGroupAddon align="block-end" className="min-h-8 justify-between px-2.5 pb-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <input ref={fileInput} type="file" aria-label="选择附件" multiple className="sr-only" onChange={(event) => addFiles(event.target.files)} />
            <InputGroupButton size="icon-sm" aria-label="添加附件" disabled={files.length >= 5} onClick={() => fileInput.current?.click()}><PlusIcon /></InputGroupButton>
            <PermissionMenu />
            {!blocked && <QueueBehaviorMenu behavior={behavior} onValueChange={setBehavior} />}
            {queued > 0 && !queueing && <Badge variant="outline" className="font-mono text-xs font-normal">Queue {queued}</Badge>}
          </div>
          <div className="flex items-center gap-1.5">
            {busy && <Button variant="outline" size="xs" onClick={() => { onAbort().catch(() => undefined); }} disabled={status === "stopping"}>{status === "stopping" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <OctagonIcon data-icon="inline-start" />}停止</Button>}
            <ModelThinkingMenu
              disabled={busy}
              models={models}
              model={model}
              thinkingLevel={thinkingLevel}
              thinkingLevels={thinkingLevels}
              onModelChange={onModelChange}
              onThinkingChange={onThinkingChange}
            />
            <Button size="icon-sm" aria-label="发送消息" disabled={(!text.trim() && files.length === 0) || submitting || blocked} onClick={() => { submit().catch(() => undefined); }}><ArrowUpIcon /></Button>
          </div>
        </InputGroupAddon>
      </InputGroup>
      </Field>
    </div>
  </div>;
}

export function PermissionMenu() {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <InputGroupButton className="text-warning" aria-label="权限：本机完整权限">
        <ShieldAlertIcon />
        <span className="hidden sm:inline">完整权限</span>
        <ChevronDownIcon className="hidden sm:block" />
      </InputGroupButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-72">
      <DropdownMenuLabel>权限模式</DropdownMenuLabel>
      <DropdownMenuRadioGroup value="full">
        <DropdownMenuRadioItem value="full" className="items-start py-2">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">本机完整权限</span>
            <span className="text-xs leading-4 text-muted-foreground">可读写文件并运行命令，当前没有系统级沙箱隔离</span>
          </span>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function QueuePreview({ queue }: { queue: { steering: string[]; followUp: string[] } }) {
  const items = [
    ...queue.steering.map((text, index) => ({ id: `steer-${index}`, behavior: "steer" as const, text })),
    ...queue.followUp.map((text, index) => ({ id: `follow-up-${index}`, behavior: "followUp" as const, text })),
  ];

  return <div data-testid="queued-messages" className="mb-2 overflow-hidden rounded-xl border border-border bg-background px-3 py-1.5">
    {items.map((item) => <div key={item.id} className="flex min-h-8 items-center gap-2.5 py-1 text-sm">
      {item.behavior === "steer" ? <RouteIcon className="size-4 shrink-0 text-muted-foreground" /> : <ArrowUpIcon className="size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{item.text || "附件消息"}</span>
      <span className="shrink-0 text-muted-foreground">{queueBehaviorLabel(item.behavior)}</span>
    </div>)}
  </div>;
}

function QueueBehaviorMenu({ behavior, onValueChange }: { behavior: QueueBehavior; onValueChange(value: QueueBehavior): void }) {
  const Icon = behavior === "steer" ? RouteIcon : ArrowUpIcon;

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <InputGroupButton aria-label={`选择消息投递方式，当前 ${queueBehaviorLabel(behavior)}`} className="gap-1.5">
        <Icon />
        <span>{queueBehaviorLabel(behavior)}</span>
        <ChevronDownIcon />
      </InputGroupButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-64">
      <DropdownMenuLabel>运行中消息</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={behavior} onValueChange={(value) => onValueChange(value as QueueBehavior)}>
        <DropdownMenuRadioItem value="followUp" className="items-start py-2">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-medium"><ArrowUpIcon className="size-4" />Follow-up</span>
            <span className="text-xs leading-4 text-muted-foreground">当前运行完成后继续处理</span>
          </span>
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="steer" className="items-start py-2">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-medium"><RouteIcon className="size-4" />Steer</span>
            <span className="text-xs leading-4 text-muted-foreground">向当前运行追加方向</span>
          </span>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function queueBehaviorLabel(behavior: QueueBehavior): string {
  return behavior === "steer" ? "Steer" : "Follow-up";
}

function ModelThinkingMenu({
  disabled, models, model, thinkingLevel, thinkingLevels, onModelChange, onThinkingChange,
}: {
  disabled: boolean;
  models: ModelOption[];
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  onModelChange(provider: string, id: string): Promise<void>;
  onThinkingChange(level: ThinkingLevel): Promise<void>;
}) {
  const modelValue = `${model.provider}/${model.id}`;
  const modelName = models.find((option) => option.provider === model.provider && option.id === model.id)?.name ?? model.id;
  const compactName = compactModelName(modelName);
  const providers = [...new Set(models.map((option) => option.provider))].sort((left, right) => {
    if (left === model.provider) return -1;
    if (right === model.provider) return 1;
    return left.localeCompare(right);
  });
  const sortedModels = [...models].sort((left, right) => {
    const leftSelected = left.provider === model.provider && left.id === model.id;
    const rightSelected = right.provider === model.provider && right.id === model.id;
    if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
    return right.id.localeCompare(left.id, undefined, { numeric: true, sensitivity: "base" });
  });

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <InputGroupButton disabled={disabled} className="max-w-52 gap-1.5 border-transparent text-muted-foreground focus-visible:ring-0" aria-label={`模型 ${modelName}，思考深度 ${thinkingLabel(thinkingLevel)}`}>
        <span className="max-w-24 truncate sm:max-w-32">{compactName}</span>
        <span>{thinkingLabel(thinkingLevel)}</span>
        <ChevronDownIcon />
      </InputGroupButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="end" className="w-56 p-1">
      <DropdownMenuGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="min-h-11 px-2 sm:min-h-8" aria-label={`选择模型，当前 ${modelName}`}>
            <span className="font-medium">模型</span>
            <span className="ml-auto max-w-32 truncate text-muted-foreground">{compactName}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent sideOffset={4} className="max-h-[min(26rem,calc(100vh-2rem))] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto p-1">
              <DropdownMenuRadioGroup value={modelValue} onValueChange={(value) => {
                const separator = value.indexOf("/");
                onModelChange(value.slice(0, separator), value.slice(separator + 1)).catch(() => undefined);
              }}>
                {providers.map((provider) => <DropdownMenuGroup key={provider}>
                  {providers.length > 1 && <DropdownMenuLabel className="px-2 pb-0.5 pt-1.5 font-mono text-[var(--type-meta)] first:pt-1">{provider}</DropdownMenuLabel>}
                  {sortedModels.filter((option) => option.provider === provider).map((option) => <DropdownMenuRadioItem
                    key={`${option.provider}/${option.id}`}
                    value={`${option.provider}/${option.id}`}
                    className="min-h-11 px-2 pr-8 sm:min-h-8"
                    title={option.name}
                  >
                    <span className="min-w-0 flex-1 truncate">{compactModelName(option.name)}</span>
                  </DropdownMenuRadioItem>)}
                </DropdownMenuGroup>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="min-h-11 px-2 sm:min-h-8" aria-label={`选择思考深度，当前 ${thinkingLabel(thinkingLevel)}`}>
            <span className="font-medium">思考深度</span>
            <span className="ml-auto text-muted-foreground">{thinkingLabel(thinkingLevel)}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent sideOffset={4} className="w-56 max-w-[calc(100vw-1rem)] p-1">
              <DropdownMenuLabel className="px-2 py-1 text-xs">思考深度</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={thinkingLevel} onValueChange={(value) => { onThinkingChange(value as ThinkingLevel).catch(() => undefined); }}>
                <DropdownMenuGroup>
                  {thinkingLevels.map((level) => <DropdownMenuRadioItem key={level} value={level} className="min-h-11 items-start px-2 py-1.5 pr-8 sm:min-h-8">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span>{thinkingLabel(level)}</span>
                      {thinkingDescription(level) && <span className="text-xs leading-4 text-muted-foreground">{thinkingDescription(level)}</span>}
                    </span>
                  </DropdownMenuRadioItem>)}
                </DropdownMenuGroup>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function thinkingLabel(level: ThinkingLevel): string {
  return ({ off: "Off", minimal: "Minimal", low: "Light", medium: "Medium", high: "High", xhigh: "Extra High", max: "Ultra" })[level];
}

function thinkingDescription(level: ThinkingLevel): string | undefined {
  if (level === "max") return "使用更多时间与额度";
  if (level === "xhigh") return "适合更复杂的推理任务";
  return undefined;
}

function compactModelName(name: string): string {
  return name.replace(/^GPT[- ]/i, "");
}

function AttachmentPreview({ file, imageInput, onRemove }: { file: File; imageInput: boolean; onRemove(): void }) {
  const [url, setUrl] = useState("");
  const isImage = file.type.startsWith("image/");
  useEffect(() => {
    if (!isImage) return undefined;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file, isImage]);

  if (isImage) return <div data-attachment-preview="image" className="group relative size-24 overflow-hidden rounded-md border bg-muted sm:size-28" title={imageInput ? file.name : `${file.name}（作为文件分析）`}>
    {url && <img src={url} alt={file.name} className="size-full object-contain" />}
    {!imageInput && <span className="absolute inset-x-1.5 bottom-1.5 truncate rounded-sm bg-background px-1.5 py-1 text-[var(--type-meta)] text-muted-foreground">作为文件分析</span>}
    <Button variant="secondary" size="icon-sm" className="absolute right-1.5 top-1.5 size-8 rounded-md border bg-background text-foreground hover:bg-muted" aria-label={`移除 ${file.name}`} onClick={onRemove}><XIcon className="size-4" /></Button>
  </div>;

  return <div data-attachment-preview="file" className="relative flex h-16 w-full max-w-56 items-center gap-2.5 rounded-md border bg-surface-subtle p-2.5 pr-9 sm:w-56">
    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0">
      <span className="block truncate text-sm font-medium" title={file.name}>{file.name}</span>
      <span className="mt-0.5 block font-mono text-[var(--type-meta)] leading-[var(--leading-meta)] text-muted-foreground">{fileLabel(file)}</span>
    </span>
    <Button variant="ghost" size="icon" className="absolute right-1.5 top-1.5 size-7 rounded-md" aria-label={`移除 ${file.name}`} onClick={onRemove}><XIcon className="size-4" /></Button>
  </div>;
}

function fileLabel(file: File): string {
  const extension = file.name.includes(".") ? file.name.split(".").pop()?.toUpperCase() : "FILE";
  const size = file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  return `${extension || "FILE"} · ${size}`;
}
