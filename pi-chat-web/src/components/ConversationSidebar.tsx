import { useEffect, useRef, useState } from "react";
import { DownloadIcon, FileInputIcon, GitBranchIcon, MessageSquareIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar";
import type { ConversationSummary, RepositoryInfo } from "../../shared/types";
import { PiLogo } from "./PiLogo";

interface Props {
  conversations: ConversationSummary[];
  selectedId?: string;
  loading: boolean;
  onSelect(id: string): void;
  onNew(): Promise<void>;
  onImport(file: File): Promise<void>;
  repository?: RepositoryInfo;
  onSettings?(): void;
  onRename(id: string, title: string): Promise<void>;
  onDelete?(id: string): Promise<void>;
}

export function ConversationSidebar({ conversations, selectedId, loading, onSelect, onNew, onImport, repository, onSettings, onRename, onDelete }: Props) {
  const importInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [renameItem, setRenameItem] = useState<ConversationSummary>();
  const [renameText, setRenameText] = useState("");
  const [deleteItem, setDeleteItem] = useState<ConversationSummary>();
  const [openMenuId, setOpenMenuId] = useState<string>();
  const openSearch = () => setSearchOpen(true);
  const selectSearchResult = (item: ConversationSummary) => {
    setSearchOpen(false);
    onSelect(item.id);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (!loading) onNew().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loading, onNew]);

  return <>
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="gap-2 border-b border-sidebar-border p-3">
        <div className="flex h-9 items-center gap-2.5">
          <span className="flex size-8 items-center justify-center text-foreground" aria-label="Pi"><PiLogo className="size-6" /></span>
          <div className="min-w-0"><strong className="block text-sm leading-4">Pi Chat</strong><span className="text-[var(--type-meta)] leading-[var(--leading-meta)] text-muted-foreground">Local workbench</span></div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" className="h-10 flex-1 justify-start rounded-lg bg-sidebar-primary px-3 text-sidebar-primary-foreground shadow-xs hover:bg-sidebar-primary/85" title="新建会话 (⌘/Ctrl+N)" onClick={() => { onNew().catch(() => undefined); }} disabled={loading}><PlusIcon data-icon="inline-start" />新建会话<kbd className="ml-auto hidden items-center gap-1 rounded bg-sidebar-primary-foreground/15 px-1.5 py-0.5 font-mono font-medium leading-none text-sidebar-primary-foreground ring-1 ring-inset ring-sidebar-primary-foreground/25 xl:inline-flex"><span className="text-sm">⌘</span><span className="text-[11px]">N</span></kbd></Button>
          <Button variant="outline" size="icon" className="size-10 shrink-0 rounded-lg border-sidebar-border bg-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-foreground aria-expanded:bg-sidebar-accent dark:bg-transparent dark:hover:bg-sidebar-accent" aria-label="导入会话" title="导入会话 (Pi Session JSONL)" onClick={() => importInput.current?.click()} disabled={loading}><FileInputIcon className="size-4" /></Button>
          <input
            ref={importInput}
            className="sr-only"
            type="file"
            accept=".jsonl,application/x-ndjson"
            aria-label="选择 JSONL 会话文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onImport(file).catch(() => undefined);
            }}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="p-2 pt-2">
          <SidebarGroupLabel className="h-7 px-2 text-xs">会话历史 <span className="ml-auto font-mono tabular-nums">{conversations.length}</span></SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {conversations.map((item) => <SidebarMenuItem key={item.id}>
                <SidebarMenuButton className={`h-auto min-h-9 rounded-md border border-transparent px-3 py-1 pr-24 hover:border-sidebar-border data-[active=true]:border-sidebar-border data-[active=true]:bg-sidebar-accent ${item.parentId ? "items-start" : "items-center"}`} isActive={item.id === selectedId} onClick={() => onSelect(item.id)} tooltip={item.title}>
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.title}</span>{item.parentId && <span className="mt-0.5 inline-flex max-w-full items-center gap-0.5 text-[10px] leading-[14px] text-muted-foreground/70"><GitBranchIcon className="size-2 shrink-0" /><span className="truncate">共享 workspace</span></span>}</span>
                </SidebarMenuButton>
                <div className={`absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 transition-opacity ${openMenuId === item.id ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover/menu-item:opacity-100 md:focus-within:opacity-100"}`}>
                  <Button variant="ghost" size="icon-sm" className="size-7 border-0 shadow-none hover:bg-transparent focus-visible:ring-0" aria-label="重命名对话" onClick={(event) => { event.stopPropagation(); setRenameItem(item); setRenameText(item.title); }}><PencilIcon className="size-3.5" /></Button>
                  <Button variant="ghost" size="icon-sm" className="size-7 border-0 text-destructive shadow-none hover:bg-transparent hover:text-destructive focus-visible:ring-0" aria-label="删除对话" disabled={!onDelete} onClick={(event) => { event.stopPropagation(); setDeleteItem(item); }}><Trash2Icon className="size-3.5" /></Button>
                  <DropdownMenu open={openMenuId === item.id} onOpenChange={(open) => setOpenMenuId(open ? item.id : undefined)}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="size-7 border-0 shadow-none hover:bg-transparent focus-visible:ring-0" aria-label="更多对话操作" onClick={(event) => event.stopPropagation()}><MoreHorizontalIcon className="size-3.5" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" sideOffset={6} className="w-44 rounded-lg p-1.5 shadow-lg">
                      <DropdownMenuGroup>
                      <DropdownMenuItem className="h-8 gap-2 px-2 text-xs [&_svg]:size-3.5" asChild><a href={`/api/conversations/${encodeURIComponent(item.id)}/export?format=jsonl`} download><DownloadIcon />导出 JSONL</a></DropdownMenuItem>
                      <DropdownMenuItem className="h-8 gap-2 px-2 text-xs [&_svg]:size-3.5" asChild><a href={`/api/conversations/${encodeURIComponent(item.id)}/export?format=html`} download><DownloadIcon />导出 HTML</a></DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </SidebarMenuItem>)}
              {conversations.length === 0 && <li className="px-2 py-8 text-center text-xs text-muted-foreground">还没有会话</li>}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-2">
        <div className="flex h-8 min-w-0 items-center gap-1">
          <Button variant="ghost" size="sm" className="shrink-0 justify-start text-muted-foreground" onClick={onSettings}><Settings2Icon data-icon="inline-start" />设置</Button>
          {repository && <div className="ml-auto flex min-w-0 items-center gap-1.5 px-1 text-[var(--type-meta)] leading-[var(--leading-meta)] text-muted-foreground" title={`${repository.branch} @ ${repository.commit}`}>
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-mono">{repository.branch}</span>
            <span className="shrink-0 font-mono">· {repository.commit}</span>
          </div>}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <CommandDialog
      open={searchOpen}
      onOpenChange={setSearchOpen}
      title="搜索会话"
      description="输入标题搜索本地会话。"
    >
      <CommandInput autoFocus placeholder="搜索会话…" aria-label="搜索会话" shortcut="ESC" />
      <CommandList aria-label="会话搜索结果">
        <CommandEmpty>没有匹配的会话</CommandEmpty>
        <CommandGroup>
          {conversations.map((item) => <CommandItem
            key={item.id}
            value={`${item.title} ${item.id}`}
            keywords={item.parentId ? ["分支", "共享 workspace"] : ["本地会话"]}
            onSelect={() => selectSearchResult(item)}
          >
            {item.parentId ? <GitBranchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <MessageSquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{item.title}</span>
              {item.parentId && <span className="mt-0.5 block truncate text-xs text-muted-foreground">共享 workspace</span>}
            </span>
          </CommandItem>)}
        </CommandGroup>
      </CommandList>
    </CommandDialog>

    <Dialog open={Boolean(renameItem)} onOpenChange={(open) => { if (!open) setRenameItem(undefined); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>重命名对话</DialogTitle><DialogDescription>新标题会写入 Pi session 元数据。</DialogDescription></DialogHeader>
        <FieldGroup><Field><FieldLabel htmlFor="conversation-title">标题</FieldLabel><Input id="conversation-title" className="focus-visible:ring-0" value={renameText} onChange={(event) => setRenameText(event.target.value)} /></Field></FieldGroup>
        <DialogFooter><Button variant="outline" onClick={() => setRenameItem(undefined)}>取消</Button><Button onClick={() => { if (renameItem) onRename(renameItem.id, renameText).then(() => setRenameItem(undefined)).catch(() => undefined); }} disabled={!renameText.trim()}>保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={Boolean(deleteItem)} onOpenChange={(open) => { if (!open) setDeleteItem(undefined); }}>
      <AlertDialogContent className="max-w-lg p-6 sm:max-w-lg">
        <AlertDialogHeader><AlertDialogTitle>删除会话？</AlertDialogTitle><AlertDialogDescription>“{deleteItem?.title}”及其本地记录将被删除，此操作不可撤销。</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter className="-mx-6 -mb-6 px-6 py-3"><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={(event) => { event.preventDefault(); if (deleteItem && onDelete) onDelete(deleteItem.id).then(() => setDeleteItem(undefined)).catch(() => undefined); }}>删除</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
