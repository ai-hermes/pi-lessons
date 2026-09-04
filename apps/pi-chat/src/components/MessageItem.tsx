import type { MessageListItem } from "@shared/types";
import { Markdown } from "@components/Markdown";
import { MessageActions } from "@components/MessageActions";
import { ThinkingItem } from "@components/ThinkingItem";
import { ToolCard } from "@components/ToolCard";

export function MessageItem({
  item,
  showActions,
}: {
  item: MessageListItem;
  showActions: boolean;
}) {
  if (item.kind === "thinking") {
    return (
      <ThinkingItem
        text={item.thinking.text}
        completed={item.thinking.completed}
      />
    );
  }
  if (item.kind === "tool") {
    return <ToolCard tool={item.tool} />;
  }
  const user = item.message.role === "user";
  return (
    <article className={"message-row " + (user ? "user-row" : "")}>
      <div className="message-column">
        <div
          className={"bubble " + (user ? "user-bubble" : "assistant-bubble")}
        >
          <Markdown content={item.message.text} />
        </div>
        {showActions && (
          <MessageActions message={item.message} timestamp={undefined} />
        )}
      </div>
    </article>
  );
}
