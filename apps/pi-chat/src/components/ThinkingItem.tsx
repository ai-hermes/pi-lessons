import { Markdown } from "@components/Markdown";
import { Button } from "@components/ui/button";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

export function ThinkingItem({ text, completed }: { text: string; completed?: boolean }) {
  const [open, setOpen] = useState(!completed);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- collapse when thinking completes.
    if (completed) setOpen(false);
  }, [completed]);

  return (
    <div className="thinking">
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Brain size={16} />
        <span>思考过程</span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </Button>
      <div
        className={"thinking-content " + (open ? "thinking-content-open" : "")}
        aria-hidden={!open}
      >
        <div className="thinking-content-inner">
          <div className="thinking-content-body">
            <Markdown content={text || "正在思考…"} />
          </div>
        </div>
      </div>
    </div>
  );
}
