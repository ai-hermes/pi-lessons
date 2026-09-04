import { useState } from "react";
import { PanelLeftClose, Pencil, Plus, Trash2, X } from "lucide-react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
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
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[];
  selectedId?: string;
  open: boolean;
  collapsed: boolean;
  onOpenChange(open: boolean): void;
  onCollapse(): void;
  onNew(): Promise<void>;
  onSelect(id: string): void;
  onRename(id: string, title: string): Promise<void>;
  onDelete(id: string): Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string>();
  const [editingTitle, setEditingTitle] = useState("");
  const selectedIndex = conversations.findIndex(
    (item) => item.id === selectedId,
  );

  const saveTitle = async (item: ConversationSummary) => {
    const title = editingTitle.trim();
    setEditingId(undefined);
    if (!title || title === item.title) return;
    try {
      await onRename(item.id, title);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "编辑会话失败");
    }
  };

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
                <div className="conversation-item-row" key={item.id}>
                  {editingId === item.id ? (
                    <input
                      className="conversation-title-input"
                      value={editingTitle}
                      maxLength={120}
                      autoFocus
                      aria-label="会话名称"
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onBlur={() => void saveTitle(item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setEditingId(undefined);
                      }}
                    />
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        className={
                          "conversation-item " +
                          (item.id === selectedId
                            ? "conversation-item-active"
                            : "")
                        }
                        onClick={() => onSelect(item.id)}
                        title={item.title}
                        aria-current={
                          item.id === selectedId ? "page" : undefined
                        }
                      >
                        <span>{item.title}</span>
                      </Button>
                      <span className="conversation-item-actions">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="编辑会话名称"
                          aria-label={`编辑 ${item.title}`}
                          onClick={() => {
                            setEditingId(item.id);
                            setEditingTitle(item.title);
                          }}
                        >
                          <Pencil size={14} />
                        </Button>
                        <AlertDialogPrimitive.Root>
                          <AlertDialogPrimitive.Trigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="conversation-delete"
                              title="删除会话"
                              aria-label={`删除 ${item.title}`}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </AlertDialogPrimitive.Trigger>
                          <AlertDialogPrimitive.Portal>
                            <AlertDialogPrimitive.Overlay className="alert-dialog-overlay" />
                            <AlertDialogPrimitive.Content className="alert-dialog-content">
                              <AlertDialogPrimitive.Title className="alert-dialog-title">
                                删除会话？
                              </AlertDialogPrimitive.Title>
                              <AlertDialogPrimitive.Description className="alert-dialog-description">
                                “{item.title}”及其消息记录将被永久删除。
                              </AlertDialogPrimitive.Description>
                              <div className="alert-dialog-actions">
                                <AlertDialogPrimitive.Cancel asChild>
                                  <Button variant="outline">取消</Button>
                                </AlertDialogPrimitive.Cancel>
                                <AlertDialogPrimitive.Action asChild>
                                  <Button
                                    className="alert-dialog-delete"
                                    onClick={() => {
                                      void onDelete(item.id).catch((error) =>
                                        window.alert(
                                          error instanceof Error
                                            ? error.message
                                            : "删除会话失败",
                                        ),
                                      );
                                    }}
                                  >
                                    删除
                                  </Button>
                                </AlertDialogPrimitive.Action>
                              </div>
                            </AlertDialogPrimitive.Content>
                          </AlertDialogPrimitive.Portal>
                        </AlertDialogPrimitive.Root>
                      </span>
                    </>
                  )}
                </div>
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
