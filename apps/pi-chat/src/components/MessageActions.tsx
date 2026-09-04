import { useState } from "react";
import { Copy } from "lucide-react";
import type { ChatMessage } from "@shared/types";
import { Button } from "@components/ui/button";

function relativeTime(value: number | string) {
  const time = typeof value === "string" ? Date.parse(value) : value;
  const elapsed = Math.max(0, Date.now() - time);
  if (elapsed < 60000) return "刚刚";
  if (elapsed < 3600000) return Math.floor(elapsed / 60000) + " 分钟前";
  if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + " 小时前";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

export function MessageActions({
  message,
  timestamp,
}: {
  message: ChatMessage;
  timestamp?: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(message.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="message-actions">
      <span>{timestamp ? relativeTime(timestamp) : "刚刚"}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void copy()}
        aria-label="复制消息"
        title="复制消息"
      >
        <Copy size={13} />
        {copied && <span>已复制</span>}
      </Button>
    </div>
  );
}
