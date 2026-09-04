import { MessageSquare, Plus, X } from "lucide-react";
import type { ConversationSummary } from "@shared/types";
import { PiLogo } from "@components/PiLogo";
import { Button } from "@components/ui/button";

export function ConversationSidebar({
  conversations,
  selectedId,
  open,
  onOpenChange,
  onNew,
  onSelect,
}: {
  conversations: ConversationSummary[];
  selectedId?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onNew(): Promise<void>;
  onSelect(id: string): void;
}) {
  return (
    <>
      {open && (
        <Button
          className="sidebar-backdrop"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          aria-label="关闭会话列表"
        />
      )}
      <aside className={"conversation-sidebar " + (open ? "sidebar-open" : "")}>
        <div className="sidebar-brand">
          <span className="brand-mark">
            <PiLogo size={18} />
          </span>
          <strong>Pi Chat</strong>
          <Button
            className="sidebar-close"
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            aria-label="关闭会话列表"
          >
            <X />
          </Button>
        </div>
        <Button className="new-chat" onClick={() => void onNew()}>
          <Plus />
          新会话
        </Button>
        <div className="conversation-list">
          <span className="conversation-list-label">会话历史</span>
          {conversations.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              className={
                "conversation-item " +
                (item.id === selectedId ? "conversation-item-active" : "")
              }
              onClick={() => onSelect(item.id)}
              title={item.title}
            >
              <MessageSquare />
              <span>{item.title}</span>
            </Button>
          ))}
          {conversations.length === 0 && (
            <p className="conversation-empty">还没有会话</p>
          )}
        </div>
      </aside>
    </>
  );
}
