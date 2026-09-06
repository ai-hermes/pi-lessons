import { Button } from "@components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@components/ui/popover";
import { Slider } from "@components/ui/slider";
import { Textarea } from "@components/ui/textarea";
import type { ModelOption, ThinkingLevel } from "@shared/types";
import { ArrowUp, ChevronDown, ChevronRight, Square } from "lucide-react";
import { useState } from "react";

const thinkingNames: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<"effort" | "models">("effort");
  const modelValue = model ? `${model.provider}/${model.id}` : "";
  const thinkingIndex = Math.max(0, thinkingLevels.indexOf(thinkingLevel ?? thinkingLevels[0]));

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
            if (event.key === "Enter" && event.altKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={busy ? "正在生成回复…" : "输入消息，按 Alt + Enter 发送…"}
          rows={1}
        />
        <div className="composer-toolbar">
          <div className="composer-settings">
            <Popover
              open={settingsOpen}
              onOpenChange={(open) => {
                setSettingsOpen(open);
                if (!open) setSettingsView("effort");
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  className="model-selector-trigger"
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  aria-label="选择模型和思考强度"
                >
                  <span className="model-selector-name">{modelValue || "Select model"}</span>
                  <span className="model-selector-effort">
                    {thinkingLevel ? thinkingNames[thinkingLevel] : "Select effort"}
                  </span>
                  <ChevronDown size={15} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="model-selector-popover"
                side="top"
                align="end"
                sideOffset={12}
              >
                {settingsView === "effort" ? (
                  <div className="effort-selector">
                    <Button
                      className="effort-selector-heading"
                      variant="ghost"
                      type="button"
                      onClick={() => setSettingsView("models")}
                    >
                      <strong>
                        {thinkingLevel ? thinkingNames[thinkingLevel] : "Select effort"}
                      </strong>
                      <ChevronRight size={18} />
                      <span>{modelValue || "Select model"}</span>
                    </Button>
                    <div className="effort-slider-wrap">
                      <div className="effort-marks" aria-hidden="true">
                        {thinkingLevels.map((level, index) => (
                          <span
                            className={
                              index <= thinkingIndex
                                ? "effort-mark effort-mark-active"
                                : "effort-mark"
                            }
                            key={level}
                            title={thinkingNames[level]}
                          />
                        ))}
                      </div>
                      <Slider
                        className="effort-slider"
                        min={0}
                        max={Math.max(0, thinkingLevels.length - 1)}
                        step={1}
                        value={[thinkingIndex]}
                        disabled={thinkingLevels.length < 2}
                        aria-label="思考强度"
                        onValueChange={([index]) => {
                          const level = thinkingLevels[index];
                          if (!level) return;
                          onThinkingChange(level).catch(console.error);
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="model-selector-list">
                    <span className="model-selector-title">Select model</span>
                    {models.map((item) => {
                      const value = `${item.provider}/${item.id}`;
                      return (
                        <Button
                          className={
                            "model-selector-option " +
                            (value === modelValue ? "model-selector-option-active" : "")
                          }
                          variant="ghost"
                          type="button"
                          key={value}
                          onClick={() => {
                            setSettingsOpen(false);
                            onModelChange(value).catch(console.error);
                          }}
                        >
                          {value}
                        </Button>
                      );
                    })}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>
          <Button
            className={"send-button " + (busy ? "stop-button" : "")}
            size="icon"
            onClick={() => (busy ? void onAbort() : submit())}
            disabled={!busy && !input.trim()}
            aria-label={busy ? "停止生成" : "发送消息"}
            title={busy ? "停止生成" : "发送消息"}
          >
            {busy ? <Square size={14} fill="currentColor" /> : <ArrowUp size={18} />}
          </Button>
        </div>
      </div>
      <div className="composer-hint">
        <span>Alt + Enter 发送 · Enter 换行</span>
      </div>
    </footer>
  );
}
