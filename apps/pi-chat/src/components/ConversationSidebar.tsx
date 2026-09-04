import { PanelLeftClose, Plus, X } from "lucide-react";
import type { ConversationSummary } from "@shared/types";
import { PiLogo } from "@components/PiLogo";
import { Button } from "@components/ui/button";

export function ConversationSidebar({
  conversations,
  selectedId,
  open,
  collapsed,
  onOpenChange,
  onCollapse,
  onNew,
  onSelect,
}: {
  conversations: ConversationSummary[];
  selectedId?: string;
  open: boolean;
  collapsed: boolean;
  onOpenChange(open: boolean): void;
  onCollapse(): void;
  onNew(): Promise<void>;
  onSelect(id: string): void;
}) {
  const selectedIndex = conversations.findIndex(
    (item) => item.id === selectedId,
  );

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
      <aside
        className={
          "conversation-sidebar " +
          (open ? "sidebar-open " : "") +
          (collapsed ? "sidebar-collapsed" : "")
        }
      >
        <div className="sidebar-content">
          <div className="sidebar-brand">
            <span className="brand-mark">
              <PiLogo size={18} />
            </span>
            <strong>Pi Chat</strong>
            <Button
              className="sidebar-collapse"
              variant="ghost"
              size="icon"
              onClick={onCollapse}
              aria-label="收起侧边栏"
            >
              <PanelLeftClose size={18} />
            </Button>
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
            <div className="conversation-items">
              {selectedIndex >= 0 && (
                <span
                  className="conversation-active-indicator"
                  style={{ transform: `translateY(${selectedIndex * 36}px)` }}
                  aria-hidden
                />
              )}
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
                  aria-current={item.id === selectedId ? "page" : undefined}
                >
                  <span>{item.title}</span>
                </Button>
              ))}
            </div>
            {conversations.length === 0 && (
              <p className="conversation-empty">还没有会话</p>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
