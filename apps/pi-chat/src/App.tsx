import { BrowserPanel } from "@components/BrowserPanel";
import { Composer } from "@components/Composer";
import { ConversationSidebar } from "@components/ConversationSidebar";
import { EmptyConversation } from "@components/EmptyConversation";
import { LoadingIndicator } from "@components/LoadingIndicator";
import { MessageItem } from "@components/MessageItem";
import { Button } from "@components/ui/button";
import { Skeleton } from "@components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@components/ui/tooltip";
import { useConversationStream } from "@hooks/useConversationStream";
import type {
  BootstrapData,
  BrowserHandoffRequest,
  ConversationConfig,
  ConversationConfigUpdate,
  ConversationSummary,
  ModelOption,
  ThinkingLevel,
} from "@shared/types";
import { Menu, Monitor, PanelLeftOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  createConversation,
  deleteConversation,
  getBootstrap,
  getConversationConfig,
  listConversations,
  renameConversation,
  updateConversationConfig,
} from "@/api";

import "./App.css";

export default function App() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [bootstrap, setBootstrap] = useState<BootstrapData>({ models: [], skills: [] });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const messageBottomRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const lastScrollYRef = useRef(0);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const {
    messageItems,
    historyLoading,
    loading,
    error: connectionError,
    status,
    send,
    abort,
    browserHandoff,
    connected,
    actionPending,
    resolveBrowserHandoff,
    browserOpen,
    openBrowser,
    closeBrowser,
    saveBrowser,
    loadBrowser,
    browser,
    selectedSkills,
    setSelectedSkills,
  } = useConversationStream(conversationId);
  const { draftConfig, model, models, thinkingLevel, thinkingLevels, changeModel, changeThinking } =
    useConversationConfig(conversationId, bootstrap.models);

  const busy =
    status === "running" ||
    status === "stopping" ||
    status === "compacting" ||
    status === "waiting_for_human";
  const browserNotice = !connected ? "正在同步连接，浏览器暂为只读…" : undefined;
  const streamedContentLength = messageItems.reduce((total, item) => {
    if (item.kind === "message") return total + item.message.text.length;
    if (item.kind === "thinking") return total + item.thinking.text.length;
    return total;
  }, 0);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    autoFollowRef.current = true;
    lastScrollYRef.current = 0;
  }, [conversationId]);

  useEffect(() => {
    (async () => {
      const bootstrapData = await getBootstrap();
      setBootstrap({ ...bootstrapData });
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const conversationList = await listConversations();
      setConversations(conversationList);
    })();
  }, [conversationId]);

  useEffect(() => {
    const onScroll = () => {
      const scrollY = window.scrollY;
      lastScrollYRef.current = scrollY;
      const distanceFromBottom =
        document.documentElement.scrollHeight - window.innerHeight - scrollY;
      autoFollowRef.current = distanceFromBottom <= 4;
      setShowScrollButton((prev) =>
        prev === distanceFromBottom > 120 ? prev : distanceFromBottom > 120,
      );
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!autoFollowRef.current) return;
    messageBottomRef.current?.scrollIntoView({ block: "end" });
  }, [busy, loading, messageItems.length, streamedContentLength]);

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    autoFollowRef.current = true;
    send(text, conversationId ? undefined : draftConfig, selectedSkills);
  };

  const startNew = async () => {
    if (!(await closeBrowser())) return;
    const created = await createConversation();
    navigate("/conversation/" + created.conversation.id);
  };

  const isEmpty = !conversationId || (!historyLoading && messageItems.length === 0);
  const conversationTitle =
    conversations.find((item) => item.id === conversationId)?.title ?? "新会话";
  return (
    <div className={"app-shell" + (browserOpen && bootstrap.browser ? " browser-open" : "")}>
      <ConversationSidebar
        conversations={conversations}
        selectedId={conversationId}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onOpenChange={setSidebarOpen}
        onCollapse={() => setSidebarCollapsed(true)}
        onNew={startNew}
        onSelect={async (id) => {
          if (!(await closeBrowser())) return;
          navigate("/conversation/" + id);
          setSidebarOpen(false);
        }}
        onRename={async (id, title) => {
          const updated = await renameConversation(id, title);
          setConversations((items) => items.map((item) => (item.id === id ? updated : item)));
        }}
        onDelete={async (id) => {
          if (id === conversationId && !(await closeBrowser())) return;
          await deleteConversation(id);
          const remaining = conversations.filter((item) => item.id !== id);
          setConversations(remaining);
          navigate(remaining[0] ? "/conversation/" + remaining[0].id : "/");
        }}
      />
      <section className="chat-shell">
        <header className="topbar">
          {sidebarCollapsed && (
            <Button
              className="sidebar-expand"
              variant="ghost"
              size="icon"
              onClick={() => setSidebarCollapsed(false)}
              aria-label="展开侧边栏"
            >
              <PanelLeftOpen size={18} />
            </Button>
          )}
          <Button
            className="sidebar-trigger"
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开会话列表"
          >
            <Menu size={18} />
          </Button>
          <span className="conversation-title">{conversationTitle}</span>
          {bootstrap.browser && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="browser-toggle"
                    variant="ghost"
                    aria-expanded={browserOpen}
                    aria-controls="browser-panel"
                    onClick={browserOpen ? closeBrowser : openBrowser}
                    disabled={!conversationId || actionPending}
                  >
                    <Monitor size={17} />
                    浏览器
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="browser-tooltip">
                  <span>
                    每个会话使用独立浏览器沙箱。人工接管时 Agent
                    暂停操作；请勿在聊天中发送密码或验证码。
                  </span>
                  <span>
                    {browser?.savedAt
                      ? `最近保存：${new Date(browser.savedAt).toLocaleString()}。`
                      : ""}
                    当前会话重建沙箱时恢复 cookies 和 localStorage，网站仍可能要求重新登录。
                  </span>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </header>
        <main className={"chat-area " + (isEmpty ? "empty-chat-area" : "")}>
          {historyLoading ? (
            <div className="conversation-skeleton" role="status" aria-label="正在加载会话">
              <div className="conversation-skeleton-user">
                <Skeleton className="conversation-skeleton-line conversation-skeleton-user-line" />
              </div>
              <div className="conversation-skeleton-assistant">
                <Skeleton className="conversation-skeleton-line conversation-skeleton-line-wide" />
                <Skeleton className="conversation-skeleton-line conversation-skeleton-line-medium" />
                <Skeleton className="conversation-skeleton-line conversation-skeleton-line-short" />
              </div>
              <div className="conversation-skeleton-user">
                <Skeleton className="conversation-skeleton-line conversation-skeleton-user-line conversation-skeleton-user-line-short" />
              </div>
              <div className="conversation-skeleton-assistant">
                <Skeleton className="conversation-skeleton-line conversation-skeleton-line-medium" />
                <Skeleton className="conversation-skeleton-line conversation-skeleton-line-short" />
              </div>
            </div>
          ) : isEmpty ? (
            <EmptyConversation onPrompt={submit} />
          ) : (
            <div className="messages">
              {messageItems.map((item) => (
                <MessageItem key={item.id} item={item} showActions={item.kind === "message"} />
              ))}
              {browserHandoff && (
                <BrowserHandoffCard browserHandoff={browserHandoff} onOpen={openBrowser} />
              )}
              {(loading || busy) && !browserHandoff && <LoadingIndicator />}
              <div className="message-bottom-spacer" ref={messageBottomRef} aria-hidden />
            </div>
          )}
          {connectionError && <div className="connection-error">{connectionError}</div>}
        </main>
        <Composer
          busy={busy}
          model={model}
          models={models}
          thinkingLevel={thinkingLevel}
          thinkingLevels={thinkingLevels}
          skills={bootstrap.skills ?? []}
          selectedSkills={selectedSkills}
          onSelectedSkillsChange={setSelectedSkills}
          onSend={submit}
          onAbort={abort}
          onModelChange={changeModel}
          onThinkingChange={changeThinking}
          showScrollButton={!historyLoading && !isEmpty && showScrollButton}
          onScrollToBottom={() => {
            autoFollowRef.current = true;
            messageBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
          }}
        />
      </section>
      {browserOpen && bootstrap.browser && (
        <BrowserPanel
          browser={browser}
          status={status}
          error={browserNotice}
          onSave={saveBrowser}
          onLoad={loadBrowser}
          browserHandoff={browserHandoff}
          actionPending={actionPending || loading}
          onResolveBrowserHandoff={resolveBrowserHandoff}
          onClose={closeBrowser}
        />
      )}
    </div>
  );
}

function BrowserHandoffCard({
  browserHandoff,
  onOpen,
}: {
  browserHandoff: BrowserHandoffRequest;
  onOpen: () => void;
}) {
  const expiresAt = new Date(browserHandoff.expiresAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    <div className="browser-handoff-card browser-handoff-message" role="status">
      <div className="browser-handoff-message-content">
        <strong>需要你完成浏览器操作</strong>
        <p className="browser-handoff-message-reason">{browserHandoff.reason}</p>
        <p className="browser-handoff-message-hint">
          打开后请完成操作并交回 Agent；{expiresAt} 前未完成将自动取消。
        </p>
      </div>
      <Button size="sm" onClick={onOpen}>
        打开浏览器
      </Button>
    </div>
  );
}

function useConversationConfig(conversationId: string | undefined, bootstrapModels: ModelOption[]) {
  const [configState, setConfigState] = useState<{
    conversationId: string;
    config: ConversationConfig;
  }>();
  const [draftConfig, setDraftConfig] = useState<ConversationConfigUpdate>({});

  useEffect(() => {
    if (!conversationId) return;

    (async () => {
      const config = await getConversationConfig(conversationId);
      setConfigState({ conversationId, config });
    })();
  }, [conversationId]);

  const config =
    configState && configState.conversationId === conversationId ? configState.config : undefined;
  const model = config?.model ?? (!conversationId ? draftConfig.model : undefined);
  const models = config?.models ?? bootstrapModels;
  const thinkingLevel =
    config?.thinkingLevel ?? (!conversationId ? draftConfig.thinkingLevel : undefined);
  const thinkingLevels =
    config?.availableThinkingLevels ??
    models.find((item) => item.provider === model?.provider && item.id === model.id)
      ?.thinkingLevels ??
    [];

  const changeModel = async (value: string) => {
    const separator = value.indexOf("/");
    if (separator < 1) return;
    const model = { provider: value.slice(0, separator), id: value.slice(separator + 1) };
    if (!conversationId) {
      const modelThinkingLevels =
        bootstrapModels.find((item) => item.provider === model.provider && item.id === model.id)
          ?.thinkingLevels ?? [];
      setDraftConfig((current) => ({
        model,
        thinkingLevel:
          current.thinkingLevel && modelThinkingLevels.includes(current.thinkingLevel)
            ? current.thinkingLevel
            : modelThinkingLevels.includes("medium")
              ? "medium"
              : modelThinkingLevels[0],
      }));
      return;
    }
    const config = await updateConversationConfig(conversationId, { model });
    setConfigState((current) =>
      current?.conversationId === conversationId ? { conversationId, config } : current,
    );
  };

  const changeThinking = async (thinkingLevel: ThinkingLevel) => {
    if (!conversationId) {
      setDraftConfig((current) => ({ ...current, thinkingLevel }));
      return;
    }
    const config = await updateConversationConfig(conversationId, { thinkingLevel });
    setConfigState((current) =>
      current?.conversationId === conversationId ? { conversationId, config } : current,
    );
  };

  return { draftConfig, model, models, thinkingLevel, thinkingLevels, changeModel, changeThinking };
}
