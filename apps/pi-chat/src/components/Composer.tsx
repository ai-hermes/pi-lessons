import { useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { ModelOption, ThinkingLevel } from "@shared/types";
import { Button } from "@components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@components/ui/select";
import { Textarea } from "@components/ui/textarea";

const thinkingNames: Record<ThinkingLevel, string> = {
  off: "关闭思考",
  minimal: "最少",
  low: "较低",
  medium: "中等",
  high: "较高",
  xhigh: "很高",
  max: "最高",
};

export function Composer({
  busy,
  model,
  models,
  thinkingLevel,
  thinkingLevels,
  onSend,
  onAbort,
  onModelChange,
  onThinkingChange,
}: {
  busy: boolean;
  model?: { provider: string; id: string };
  models: ModelOption[];
  thinkingLevel?: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  onSend(text: string): void;
  onAbort(): Promise<void>;
  onModelChange(value: string): Promise<void>;
  onThinkingChange(value: ThinkingLevel): Promise<void>;
}) {
  const [input, setInput] = useState("");
  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    onSend(text);
  };

  return (
    <footer className="composer-wrap">
      <div className="composer">
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={busy ? "正在生成回复…" : "输入消息，按 Enter 发送…"}
          rows={1}
        />
        <div className="composer-toolbar">
          <div className="composer-settings">
            <Select
              value={model ? `${model.provider}/${model.id}` : ""}
              disabled={busy || models.length === 0}
              onValueChange={(value) => void onModelChange(value)}
            >
              <SelectTrigger aria-label="选择模型">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {models.map((item) => (
                  <SelectItem
                    key={`${item.provider}/${item.id}`}
                    value={`${item.provider}/${item.id}`}
                  >
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={thinkingLevel}
              disabled={busy || thinkingLevels.length === 0}
              onValueChange={(value) =>
                void onThinkingChange(value as ThinkingLevel)
              }
            >
              <SelectTrigger aria-label="选择思考强度">
                <SelectValue placeholder="思考强度" />
              </SelectTrigger>
              <SelectContent>
                {thinkingLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {thinkingNames[level]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className={"send-button " + (busy ? "stop-button" : "")}
            size="icon"
            onClick={() => (busy ? void onAbort() : submit())}
            disabled={!busy && !input.trim()}
            aria-label={busy ? "停止生成" : "发送消息"}
            title={busy ? "停止生成" : "发送消息"}
          >
            {busy ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <ArrowUp size={18} />
            )}
          </Button>
        </div>
      </div>
      <div className="composer-hint">
        <span>Enter 发送 · Shift + Enter 换行</span>
      </div>
    </footer>
  );
}
