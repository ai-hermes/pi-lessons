import { startTransition, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { PanelRightIcon, RadioTowerIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BootstrapData, ChatMessage, ConversationSummary, GlobalQueueSettings, GlobalToolSettingsView, QueueBehavior, StreamEvent, ToolSettingsView } from "../shared/types";
import {
  abortRun, branchConversation, compactConversation, connectEvents, createConversation, deleteConversation,
  getBootstrap, getConversation, getGlobalQueueSettings, getGlobalToolSettings, getToolSettings, importConversation, listConversations, renameConversation, sendMessage, setModel, setThinking,
  updateConversationSettings, updateConversationTool, updateGlobalQueueSettings, updateGlobalTool,
} from "./api";
import { ChatTimeline } from "./components/ChatTimeline";
import { Composer } from "./components/Composer";
import { ConversationSettingsDialog } from "./components/ConversationSettingsDialog";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { HarnessSheet } from "./components/HarnessSheet";
import { snapshotReducer } from "./state";

export default function App() {
  const [snapshot, dispatch] = useReducer(snapshotReducer, undefined);
  const [bootstrap, setBootstrap] = useState<BootstrapData>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolSettings, setToolSettings] = useState<GlobalToolSettingsView>();
  const [queueSettings, setQueueSettings] = useState<GlobalQueueSettings>();
  const [toolSettingsLoading, setToolSettingsLoading] = useState(false);
  const [conversationToolSettings, setConversationToolSettings] = useState<ToolSettingsView>();
  const [conversationToolSettingsLoading, setConversationToolSettingsLoading] = useState(false);
  const [conversationEntered, setConversationEntered] = useState(false);
  const initialized = useRef(false);
  const pendingEvents = useRef<StreamEvent[]>([]);
  const eventFrame = useRef<number | undefined>(undefined);
  const refreshList = async () => setConversations(await listConversations());
  const openConversation = async (id: string) => {
    setLoading(true);
    try {
      dispatch({ type: "snapshot", snapshot: await getConversation(id) });
      setConversationEntered(true);
    }
    catch (error) { report(error); }
    finally { setLoading(false); }
  };
  const newConversation = async () => {
    setLoading(true);
    try {
      const next = await createConversation();
      dispatch({ type: "snapshot", snapshot: next });
      setConversationEntered(true);
      await refreshList();
    } catch (error) { report(error); }
    finally { setLoading(false); }
  };
  const importSession = async (file: File) => {
    setLoading(true);
    try {
      const next = await importConversation(file);
      dispatch({ type: "snapshot", snapshot: next });
      setConversationEntered(true);
      await refreshList();
      toast.success("会话已导入");
    } catch (error) { report(error); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    Promise.all([getBootstrap(), listConversations()]).then(async ([boot, items]) => {
      setBootstrap(boot);
      setConversations(items);
      if (items[0]) {
        dispatch({ type: "snapshot", snapshot: await getConversation(items[0].id) });
        setConversationEntered(true);
      }
      else dispatch({ type: "snapshot", snapshot: await createConversation() });
    }).then(refreshList).catch(report).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!snapshot) return undefined;
    const source = connectEvents(snapshot.conversation.id, snapshot.stream.id, snapshot.stream.lastEventId, (event) => {
      if (event.type === "snapshot.required" || event.type === "runtime.settled") {
        getConversation(snapshot.conversation.id).then((next) => dispatch({ type: "snapshot", snapshot: next })).then(refreshList).catch(report);
      } else {
        if (event.type === "conversation.renamed") refreshList().catch(report);
        pendingEvents.current.push(event);
        if (eventFrame.current === undefined) {
          eventFrame.current = requestAnimationFrame(() => {
            const events = pendingEvents.current.splice(0);
            eventFrame.current = undefined;
            startTransition(() => events.forEach((next) => dispatch({ type: "event", event: next })));
          });
        }
      }
    }, setConnected);
    return () => {
      source.close();
      if (eventFrame.current !== undefined) cancelAnimationFrame(eventFrame.current);
      eventFrame.current = undefined;
      pendingEvents.current = [];
    };
  }, [snapshot?.conversation.id, snapshot?.stream.id]);

  useEffect(() => {
    if (!settingsOpen) return;
    setToolSettings(undefined);
    setQueueSettings(undefined);
    setToolSettingsLoading(true);
    Promise.all([getGlobalToolSettings(), getGlobalQueueSettings()])
      .then(([tools, queue]) => {
        setToolSettings(tools);
        setQueueSettings(queue);
      })
      .catch(report)
      .finally(() => setToolSettingsLoading(false));
  }, [settingsOpen]);

  useEffect(() => {
    if (!inspectorOpen || !snapshot) return;
    setConversationToolSettings(undefined);
    setConversationToolSettingsLoading(true);
    getToolSettings(snapshot.conversation.id)
      .then(setConversationToolSettings)
      .catch(report)
      .finally(() => setConversationToolSettingsLoading(false));
  }, [inspectorOpen, snapshot?.conversation.id]);

  const selectedModel = useMemo(() => bootstrap?.models.find((model) => model.provider === snapshot?.model.provider && model.id === snapshot?.model.id), [bootstrap, snapshot?.model]);
  const guarded = async (action: () => Promise<unknown>, success?: string) => {
    try { await action(); if (success) toast.success(success); }
    catch (error) { report(error); }
  };

  return <>
    <ConversationSidebar
      conversations={conversations}
      selectedId={conversationEntered ? snapshot?.conversation.id : undefined}
      loading={loading}
      onSelect={(id) => { openConversation(id).catch(report); }}
      onNew={newConversation}
      onImport={importSession}
      repository={bootstrap?.repository}
      onSettings={() => setSettingsOpen(true)}
      onRename={async (id, title) => guarded(async () => { await renameConversation(id, title); await refreshList(); if (snapshot?.conversation.id === id) dispatch({ type: "snapshot", snapshot: await getConversation(id) }); }, "已重命名")}
      onDelete={async (id) => guarded(async () => {
        await deleteConversation(id);
        const next = await listConversations();
        setConversations(next);
        if (snapshot?.conversation.id === id) {
          if (next[0]) dispatch({ type: "snapshot", snapshot: await getConversation(next[0].id) });
          else dispatch({ type: "snapshot", snapshot: await createConversation() });
        }
      }, "已删除")}
    />
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background md:flex-row">
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header data-slot="app-header" className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 md:px-4">
        <SidebarTrigger className="size-8 border bg-background" />
        <div className="min-w-0">
          <h1 className="truncate text-[var(--type-section)] leading-5">{conversationEntered ? snapshot?.conversation.title : "新对话"}</h1>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <span className="hidden h-7 shrink-0 items-center gap-1.5 rounded-md bg-transparent px-2 text-xs text-muted-foreground sm:inline-flex" title={connected ? "实时连接正常" : "正在重新连接"}>
            <RadioTowerIcon className={connected ? "size-3.5 text-success" : "size-3.5 text-muted-foreground"} />
            {connected ? "Live" : "Reconnecting"}
          </span>
          <Tooltip><TooltipTrigger asChild><Button variant={inspectorOpen ? "secondary" : "ghost"} size="icon-sm" className="size-8 bg-transparent shadow-none" aria-label="打开会话明细" disabled={!snapshot} onClick={() => setInspectorOpen(true)}><PanelRightIcon className="size-4.5" /></Button></TooltipTrigger><TooltipContent>会话明细</TooltipContent></Tooltip>
        </div>
      </header>

      {!snapshot ? <LoadingState /> : <>
        <ChatTimeline showWelcome={!conversationEntered} conversationId={snapshot.conversation.id} messages={snapshot.messages} tools={snapshot.tools} thinking={snapshot.thinking} onBranch={async (entryId, text) => guarded(async () => { const next = await branchConversation(snapshot.conversation.id, entryId, text); dispatch({ type: "snapshot", snapshot: next }); setConversationEntered(true); await refreshList(); }, "分支已创建")} />
        <Composer
          status={snapshot.status}
          imageInput={selectedModel?.imageInput ?? false}
          models={bootstrap?.models ?? []}
          model={snapshot.model}
          thinkingLevel={snapshot.thinkingLevel}
          thinkingLevels={snapshot.availableThinkingLevels}
          queue={snapshot.queue}
          onSend={async (text, images, behavior: QueueBehavior) => {
            setConversationEntered(true);
            const willQueue = snapshot.status === "running";
            const optimistic: ChatMessage = {
              id: `optimistic_${crypto.randomUUID()}`,
              role: "user",
              text: text.trim(),
              images: [],
              timestamp: Date.now(),
              pending: true,
            };
            if (!willQueue) dispatch({ type: "user.optimistic", message: optimistic });
            try {
              await sendMessage(snapshot.conversation.id, text, images, behavior);
            } catch (error) {
              if (!willQueue) dispatch({ type: "user.rollback", id: optimistic.id });
              report(error);
              throw error;
            }
          }}
          onAbort={async () => guarded(async () => { await abortRun(snapshot.conversation.id); }, "已请求停止")}
          onModelChange={async (provider, id) => guarded(async () => { await setModel(snapshot.conversation.id, provider, id); dispatch({ type: "snapshot", snapshot: await getConversation(snapshot.conversation.id) }); })}
          onThinkingChange={async (level) => guarded(async () => { await setThinking(snapshot.conversation.id, level); dispatch({ type: "snapshot", snapshot: await getConversation(snapshot.conversation.id) }); })}
        />
      </>}
      </main>
    {bootstrap && snapshot && <HarnessSheet
      open={inspectorOpen}
      onOpenChange={setInspectorOpen}
      snapshot={snapshot}
      onCompact={async (instructions) => guarded(async () => { await compactConversation(snapshot.conversation.id, instructions); }, "已开始压缩")}
      toolSettings={conversationToolSettings}
      toolSettingsLoading={conversationToolSettingsLoading}
      onSettings={async (settings) => {
        try {
          await updateConversationSettings(snapshot.conversation.id, settings);
          dispatch({ type: "snapshot", snapshot: await getConversation(snapshot.conversation.id) });
        } catch (error) { report(error); throw error; }
      }}
      onConversationTool={async (name, enabled) => {
        try { setConversationToolSettings(await updateConversationTool(snapshot.conversation.id, name, enabled)); }
        catch (error) { report(error); throw error; }
      }}
    />}
    <ConversationSettingsDialog
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      toolSettings={toolSettings}
      queueSettings={queueSettings}
      toolSettingsLoading={toolSettingsLoading}
      onGlobalTool={async (name, enabled) => {
        try { setToolSettings(await updateGlobalTool(name, enabled)); }
        catch (error) { report(error); throw error; }
      }}
      onGlobalQueue={async (settings) => {
        try { setQueueSettings(await updateGlobalQueueSettings(settings)); }
        catch (error) { report(error); throw error; }
      }}
    />
    </SidebarInset>
  </>;
}

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toast.error(message);
}

function LoadingState() {
  return <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 md:px-6">
    <div className="flex items-start gap-3"><Skeleton className="size-7 rounded-lg" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-3 w-20" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div></div>
    <div className="flex justify-end"><Skeleton className="h-20 w-2/3 rounded-xl" /></div>
    <div className="flex items-start gap-3"><Skeleton className="size-7 rounded-lg" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-24 w-full rounded-xl" /></div></div>
  </div>;
}
