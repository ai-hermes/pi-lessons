import { Composer } from "@components/Composer";
import { ConversationSidebar } from "@components/ConversationSidebar";
import { EmptyConversation } from "@components/EmptyConversation";
import { LoadingIndicator } from "@components/LoadingIndicator";
import { MessageItem } from "@components/MessageItem";
import { Button } from "@components/ui/button";
import { useConversationStream } from "@hooks/useConversationStream";
import type {
  BootstrapData,
  ConversationConfig,
  ConversationConfigUpdate,
  ConversationSummary,
  ModelOption,
  ThinkingLevel,
} from "@shared/types";
import { Menu, PanelLeftOpen } from "lucide-react";
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
    loading,
    error: connectionError,
    status,
    send,
    abort,
    selectedSkills,
    setSelectedSkills,
  } = useConversationStream(conversationId);
  const { draftConfig, model, models, thinkingLevel, thinkingLevels, changeModel, changeThinking } =
    useConversationConfig(conversationId, bootstrap.models);

  const busy = status === "running" || status === "stopping" || status === "compacting";
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
    const created = await createConversation();
    navigate("/conversation/" + created.conversation.id);
  };

  const isEmpty = !conversationId || messageItems.length === 0;
  const conversationTitle =
    conversations.find((item) => item.id === conversationId)?.title ?? "新会话";
  return (
    <div className="app-shell">
      <ConversationSidebar
        conversations={conversations}
        selectedId={conversationId}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onOpenChange={setSidebarOpen}
        onCollapse={() => setSidebarCollapsed(true)}
        onNew={startNew}
        onSelect={(id) => {
          navigate("/conversation/" + id);
          setSidebarOpen(false);
        }}
        onRename={async (id, title) => {
          const updated = await renameConversation(id, title);
          setConversations((items) => items.map((item) => (item.id === id ? updated : item)));
        }}
        onDelete={async (id) => {
          await deleteConversation(id);
          setConversations((items) => items.filter((item) => item.id !== id));
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
        </header>
        <main className={"chat-area " + (isEmpty ? "empty-chat-area" : "")}>
          {isEmpty ? (
            <EmptyConversation onPrompt={submit} />
          ) : (
            <div className="messages">
              {messageItems.map((item) => (
                <MessageItem key={item.id} item={item} showActions={item.kind === "message"} />
              ))}
              {(loading || busy) && <LoadingIndicator />}
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
          showScrollButton={showScrollButton}
          onScrollToBottom={() => {
            autoFollowRef.current = true;
            messageBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
          }}
        />
      </section>
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
