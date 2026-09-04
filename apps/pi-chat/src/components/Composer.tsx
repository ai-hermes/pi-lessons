import { useEffect, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, Square } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import type { ModelOption, ThinkingLevel } from "@shared/types";
import { Button } from "@components/ui/button";
import { Textarea } from "@components/ui/textarea";

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
  const [settingsView, setSettingsView] = useState<"effort" | "models">(
    "effort",
  );
  const [selectedModel, setSelectedModel] = useState(model);
  const [selectedThinking, setSelectedThinking] = useState(thinkingLevel);
  const modelValue = selectedModel
    ? `${selectedModel.provider}/${selectedModel.id}`
    : "";
  const thinkingIndex = Math.max(
    0,
    thinkingLevels.indexOf(selectedThinking ?? thinkingLevels[0]),
  );
  const thinkingProgress =
    thinkingLevels.length > 1
      ? (thinkingIndex / (thinkingLevels.length - 1)) * 100
      : 0;

  useEffect(() => {
    setSelectedModel(model);
  }, [model?.id, model?.provider]);

  useEffect(() => {
    setSelectedThinking(thinkingLevel);
  }, [thinkingLevel]);

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
          placeholder={
            busy ? "正在生成回复…" : "输入消息，按 Alt + Enter 发送…"
          }
          rows={1}
        />
        <div className="composer-toolbar">
          <div className="composer-settings">
            <PopoverPrimitive.Root
              open={settingsOpen}
              onOpenChange={(open) => {
                setSettingsOpen(open);
                if (!open) setSettingsView("effort");
              }}
            >
              <PopoverPrimitive.Trigger asChild>
                <button
                  className="model-selector-trigger"
                  type="button"
                  disabled={busy}
                  aria-label="选择模型和思考强度"
                >
                  <span className="model-selector-name">
                    {modelValue || "Select model"}
                  </span>
                  <span className="model-selector-effort">
                    {selectedThinking
                      ? thinkingNames[selectedThinking]
                      : "Select effort"}
                  </span>
                  <ChevronDown size={15} />
                </button>
              </PopoverPrimitive.Trigger>
              <PopoverPrimitive.Portal>
                <PopoverPrimitive.Content
                  className="model-selector-popover"
                  side="top"
                  align="end"
                  sideOffset={12}
                >
                  {settingsView === "effort" ? (
                    <div className="effort-selector">
                      <button
                        className="effort-selector-heading"
                        type="button"
                        onClick={() => setSettingsView("models")}
                      >
                        <strong>
                          {selectedThinking
                            ? thinkingNames[selectedThinking]
                            : "Select effort"}
                        </strong>
                        <ChevronRight size={18} />
                        <span>{modelValue || "Select model"}</span>
                      </button>
                      <div className="effort-slider-wrap">
                        <span
                          className="effort-slider-track"
                          style={{
                            background: `linear-gradient(to right, #555 ${thinkingProgress}%, #e5e5e5 ${thinkingProgress}%)`,
                          }}
                          aria-hidden
                        />
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
                        <input
                          className="effort-slider"
                          type="range"
                          min={0}
                          max={Math.max(0, thinkingLevels.length - 1)}
                          value={thinkingIndex}
                          disabled={thinkingLevels.length < 2}
                          aria-label="思考强度"
                          onChange={(event) => {
                            const level =
                              thinkingLevels[Number(event.currentTarget.value)];
                            if (!level) return;
                            setSelectedThinking(level);
                            void onThinkingChange(level);
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
                          <button
                            className={
                              "model-selector-option " +
                              (value === modelValue
                                ? "model-selector-option-active"
                                : "")
                            }
                            type="button"
                            key={value}
                            onClick={() => {
                              setSelectedModel(item);
                              setSettingsOpen(false);
                              void onModelChange(value);
                            }}
                          >
                            {value}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </PopoverPrimitive.Content>
              </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>
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
        <span>Alt + Enter 发送 · Enter 换行</span>
      </div>
    </footer>
  );
}
