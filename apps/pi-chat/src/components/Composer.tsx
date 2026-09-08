import { Button } from "@components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@components/ui/popover";
import { Slider } from "@components/ui/slider";
import { Textarea } from "@components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@components/ui/tooltip";
import type { ModelOption, SkillOption, ThinkingLevel } from "@shared/types";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Search, Square, Zap } from "lucide-react";
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
  skills,
  selectedSkills,
  onSelectedSkillsChange,
  onSend,
  onAbort,
  onModelChange,
  onThinkingChange,
  showScrollButton,
  onScrollToBottom,
}: {
  busy: boolean;
  model?: { provider: string; id: string };
  models: ModelOption[];
  thinkingLevel?: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  skills: SkillOption[];
  selectedSkills: string[];
  onSelectedSkillsChange(skills: string[]): void;
  onSend(text: string, skills: string[]): void;
  onAbort(): Promise<void>;
  onModelChange(value: string): Promise<void>;
  onThinkingChange(value: ThinkingLevel): Promise<void>;
  showScrollButton: boolean;
  onScrollToBottom(): void;
}) {
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<"effort" | "models">("effort");
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const hasSkills = skills.length > 0;
  const modelValue = model ? `${model.provider}/${model.id}` : "";
  const thinkingIndex = Math.max(0, thinkingLevels.indexOf(thinkingLevel ?? thinkingLevels[0]));
  const sendDisabled = !busy && !input.trim();

  const filteredSkills = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
      s.description.toLowerCase().includes(skillSearch.toLowerCase()),
  );

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    onSend(text, selectedSkills);
  };

  return (
    <footer className="composer-wrap">
      {showScrollButton && (
        <Button
          className="scroll-bottom-button"
          variant="ghost"
          size="icon"
          aria-label="滚动到底部"
          onClick={onScrollToBottom}
        >
          <ArrowDown size={18} />
        </Button>
      )}
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
            <Popover open={hasSkills ? skillOpen : false} onOpenChange={setSkillOpen}>
              <PopoverTrigger asChild>
                <Button
                  className="skill-selector-trigger"
                  variant="ghost"
                  type="button"
                  disabled={busy || !hasSkills}
                  aria-label={hasSkills ? "选择技能" : "当前没有可用技能"}
                  title={
                    hasSkills
                      ? "选择技能"
                      : "当前没有可用技能，请先在项目根目录的 skills/ 下安装 SKILL.md"
                  }
                >
                  <Zap size={15} />
                  <span className="skill-selector-label">
                    {hasSkills
                      ? selectedSkills.length > 0
                        ? `技能 (${selectedSkills.length})`
                        : "技能"
                      : "无技能"}
                  </span>
                  <ChevronDown size={15} />
                </Button>
              </PopoverTrigger>
              {hasSkills && (
                <PopoverContent
                  className="skill-selector-popover"
                  side="top"
                  align="start"
                  sideOffset={12}
                >
                  <div className="skill-search-wrap">
                    <Search size={14} className="skill-search-icon" />
                    <input
                      className="skill-search-input"
                      placeholder="搜索技能…"
                      value={skillSearch}
                      onChange={(e) => setSkillSearch(e.target.value)}
                    />
                  </div>
                  <div className="skill-list">
                    {filteredSkills.map((skill) => {
                      const checked = selectedSkills.includes(skill.name);
                      return (
                        <button
                          key={skill.name}
                          type="button"
                          className={"skill-option " + (checked ? "skill-option-active" : "")}
                          onClick={() => {
                            onSelectedSkillsChange(
                              checked
                                ? selectedSkills.filter((s) => s !== skill.name)
                                : [...selectedSkills, skill.name],
                            );
                          }}
                        >
                          <span className="skill-option-check" aria-hidden>
                            {checked ? "✓" : ""}
                          </span>
                          <span className="skill-option-text">
                            <span className="skill-option-name">{skill.name}</span>
                            <span className="skill-option-desc">{skill.description}</span>
                          </span>
                        </button>
                      );
                    })}
                    {filteredSkills.length === 0 && (
                      <span className="skill-empty">未找到匹配的技能</span>
                    )}
                  </div>
                </PopoverContent>
              )}
            </Popover>
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
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    className={"send-button " + (busy ? "stop-button" : "")}
                    size="icon"
                    onClick={() => (busy ? void onAbort() : submit())}
                    disabled={sendDisabled}
                    aria-label={busy ? "停止生成" : "发送消息"}
                  >
                    {busy ? <Square size={14} fill="currentColor" /> : <ArrowUp size={18} />}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {sendDisabled ? "请输入内容后发送" : busy ? "停止生成" : "发送消息"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <div className="composer-hint">
        <span>Alt + Enter 发送 · Enter 换行</span>
      </div>
    </footer>
  );
}
