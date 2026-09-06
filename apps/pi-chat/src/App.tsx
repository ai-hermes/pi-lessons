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
  ConversationSummary,
  ThinkingLevel,
} from "@shared/types";
import { Menu, PanelLeftOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  createConversation,
  deleteConversation,
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
  const [configState, setConfigState] = useState<{
    conversationId: string;
    config: ConversationConfig;
  }>();
  const [bootstrap, setBootstrap] = useState<BootstrapData>({ models: [] });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const messageBottomRef = useRef<HTMLDivElement>(null);
  const scrollAfterSubmitRef = useRef(false);
  const {
    messageItems,
    loading,
    error: connectionError,
    status,
    send,
    abort,
  } = useConversationStream(conversationId);
  const [input, setInput] = useState("");
  const busy = status === "running" || status === "stopping" || status === "compacting";
  const streamedContentLength = messageItems.reduce((total, item) => {
    if (item.kind === "message") return total + item.message.text.length;
    if (item.kind === "thinking") return total + item.thinking.text.length;
    return total;
  }, 0);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;

    (async () => {
      const conversationConfig = await getConversationConfig(conversationId);
      setConfigState({
        conversationId,
        config: conversationConfig,
      });
    })();
  }, [conversationId]);

  useEffect(() => {
    (async () => {
      const conversationList = await listConversations();
      setConversations(conversationList);
    })();
  }, []);

  useEffect(() => {
    if (!scrollAfterSubmitRef.current || messageItems.length === 0) return;

    scrollAfterSubmitRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      messageBottomRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationId, messageItems.length]);

  useEffect(() => {
    if (!loading) return;

    const frame = window.requestAnimationFrame(() => {
      messageBottomRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, streamedContentLength]);

  const submit = (value = input) => {
    const text = value.trim();
    if (!text) return;
    scrollAfterSubmitRef.current = true;
    setInput("");
    void send(text);
  };

  const startNew = async () => {
    const created = await createConversation();
    navigate("/conversation/" + created.conversation.id);
  };

  const changeModel = async (value: string) => {
    // value => ${provider_id}/${model_id}
    if (!conversationId) return;
    const separator = value.indexOf("/");
    if (separator < 1) return;
    const id = conversationId;
    const config = await updateConversationConfig(id, {
      model: {
        provider: value.slice(0, separator),
        id: value.slice(separator + 1),
      },
    });
    setConfigState((current) => {
      return current?.conversationId === id ? { conversationId: id, config } : current;
    });
  };

  const changeThinking = async (level: ThinkingLevel) => {
    if (!conversationId) return;
    const id = conversationId;
    const config = await updateConversationConfig(id, {
      thinkingLevel: level,
    });
    setConfigState((current) =>
      current?.conversationId === id ? { conversationId: id, config } : current,
    );
  };

  const isEmpty = !conversationId || messageItems.length === 0;

  const config =
    configState && configState.conversationId === conversationId ? configState.config : undefined;
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
          <span className="conversation-title">{"新会话"}</span>
        </header>
        <main className={"chat-area " + (isEmpty ? "empty-chat-area" : "")}>
          {isEmpty ? (
            <EmptyConversation onPrompt={submit} />
          ) : (
            <div className="messages">
              {messageItems.map((item) => (
                <MessageItem key={item.id} item={item} showActions={item.kind === "message"} />
              ))}
              {loading && <LoadingIndicator />}
              <div className="message-bottom-spacer" ref={messageBottomRef} aria-hidden />
            </div>
          )}
          {connectionError && <div className="connection-error">{connectionError}</div>}
        </main>
        <Composer
          busy={busy}
          model={config?.model}
          models={config?.models ?? []}
          thinkingLevel={config?.thinkingLevel}
          thinkingLevels={config?.availableThinkingLevels ?? []}
          onSend={submit}
          onAbort={abort}
          onModelChange={changeModel}
          onThinkingChange={changeThinking}
        />
      </section>
    </div>
  );
}
