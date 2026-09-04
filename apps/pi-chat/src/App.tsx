import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Menu, PanelLeftOpen } from "lucide-react";
import type {
  BootstrapData,
  ConversationSummary,
  ThinkingLevel,
} from "@shared/types";
import { EmptyConversation } from "@components/EmptyConversation";
import { LoadingIndicator } from "@components/LoadingIndicator";
import { MessageItem } from "@components/MessageItem";
import { Button } from "@components/ui/button";
import { Composer } from "@components/Composer";
import { ConversationSidebar } from "@components/ConversationSidebar";
import { useConversationStream } from "@hooks/useConversationStream";
import { createConversation } from "@/api";
import "./App.css";

export default function App() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<ConversationSummary[]>([
    {
      "id": "7590e3b3-6f8e-4248-bf76-2e8367415927",
      "title": "New Conversation",
      "workspaceDir": "/Users/aholic/.pi/agent/pi-chat/workspaces/7590e3b3-6f8e-4248-bf76-2e8367415927",
      "createdAt": "2026-08-31T07:03:46.380Z",
      "updatedAt": "2026-08-31T07:03:46.380Z",
      "status": 'ready'
    },
    {
      "id": "284e3258-07d1-4e48-93aa-06230b2a4b4d",
      "title": "New Conversation",
      "workspaceDir": "/Users/aholic/.pi/agent/pi-chat/workspaces/284e3258-07d1-4e48-93aa-06230b2a4b4d",
      "createdAt": "2026-08-31T08:56:44.142Z",
      "updatedAt": "2026-08-31T08:56:44.142Z",
      "status": 'ready'
    }
  ]);
  const [bootstrap, setBootstrap] = useState<BootstrapData>({ models: [] });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const messageBottomRef = useRef<HTMLDivElement>(null);
  const scrollAfterSubmitRef = useRef(false);
  const {
    messageItems,
    loading,
    error: connectionError,
    send,
  } = useConversationStream(conversationId);
  const [input, setInput] = useState("");
  const busy =
    status === "running" || status === "stopping" || status === "compacting";
  const streamedContentLength = messageItems.reduce((total, item) => {
    if (item.kind === "message") return total + item.message.text.length;
    if (item.kind === "thinking") return total + item.thinking.text.length;
    return total;
  }, 0);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [conversationId]);

  useEffect(() => { }, []);

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

  const changeModel = async (value: string) => { };

  const changeThinking = async (level: ThinkingLevel) => { };

  const isEmpty = !conversationId || messageItems.length === 0;
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
          scrollAfterSubmitRef.current = false;
          navigate("/conversation/" + id);
          setSidebarOpen(false);
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
                <MessageItem
                  key={item.id}
                  item={item}
                  showActions={item.kind === "message"}
                />
              ))}
              {loading && <LoadingIndicator />}
              <div
                className="message-bottom-spacer"
                ref={messageBottomRef}
                aria-hidden
              />
            </div>
          )}
          {connectionError && (
            <div className="connection-error">{connectionError}</div>
          )}
        </main>
        <Composer
          busy={busy}
          model={{ provider: "kimi-coding", id: "kimi-for-coding" }}
          models={[
            { provider: "kimi-coding", id: "kimi-for-coding", name: 'kimi-for-coding', contextWindow: 268_435_456, reasoning: true, imageInput: true },
            { provider: "kimi-coding", id: "kimi-for-coding-highspeed", name: 'kimi-for-coding-highspeed', contextWindow: 1_073_741_824, reasoning: true, imageInput: true },
            { provider: "kimi-coding", id: "k3", name: 'k3', contextWindow: 1_073_741_824, reasoning: true, imageInput: true },
          ]}
          thinkingLevel={"off"}
          thinkingLevels={["off", "minimal", "low", "medium", "high", "xhigh", "max"]}
          onSend={submit}
          onAbort={async () => { }}
          onModelChange={changeModel}
          onThinkingChange={changeThinking}
        />
      </section>
    </div>
  );
}
