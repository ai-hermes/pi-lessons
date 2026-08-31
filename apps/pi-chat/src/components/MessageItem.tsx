import type { MessageListItem } from "../../shared/types";
import { Markdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { ThinkingItem } from "./ThinkingItem";
import { ToolCard } from "./ToolCard";

export function MessageItem({
  item,
  showActions,
}: {
  item: MessageListItem;
  showActions: boolean;
}) {
  if (item.kind === "thinking") {
    return <ThinkingItem text={item.thinking.text} />;
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
