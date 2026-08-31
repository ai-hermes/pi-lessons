import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowUp, Plus } from "lucide-react";
import { EmptyConversation } from "@components/EmptyConversation";
import { MessageItem } from "@components/MessageItem";
import { PiLogo } from "@components/PiLogo";
import { useConversationStream } from "@hooks/useConversationStream";
import "./App.css";

export default function App() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const {
    messageItems,
    loading,
    error: connectionError,
    send,
  } = useConversationStream(conversationId);
  const submit = (value = input) => {
    const text = value.trim();
    if (!text) return;
    setInput("");
    void send(text);
  };
  const startNew = () => {
    navigate("/conversation/" + crypto.randomUUID());
  };
  const title = "新会话";
  const isEmpty = !conversationId || messageItems.length === 0;
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <PiLogo size={18} />
          </div>
          <span className="conversation-title">{title}</span>
        </div>
        <button className="new-chat" onClick={() => void startNew()}>
          <Plus size={16} />
          新会话
        </button>
      </header>
      <main className={"chat-area " + (isEmpty ? "empty-chat-area" : "")}>
        {isEmpty ? (
          <EmptyConversation onPrompt={(text) => void submit(text)} />
        ) : (
          <div className="messages">
            {messageItems.map((item) => (
              <MessageItem
                key={item.id}
                item={item}
                showActions={item.kind === "message"}
              />
            ))}
          </div>
        )}
        {connectionError && (
          <div className="connection-error">{connectionError}</div>
        )}
      </main>
      <footer className="composer-wrap">
        <div className="composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="输入消息，按 Enter 发送…"
            rows={1}
          />
          <button
            className="send-button"
            onClick={() => void submit()}
            disabled={!input.trim() || loading}
            aria-label="发送"
          >
            <ArrowUp size={18} />
          </button>
        </div>
        <div className="composer-hint">
          <span className="composer-model">deepseek-v4-flash</span>
          <span>Enter 发送 · Shift + Enter 换行</span>
        </div>
      </footer>
    </div>
  );
}
