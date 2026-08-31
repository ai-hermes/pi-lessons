import { useEffect, useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { Markdown } from "./Markdown";

export function ThinkingItem({
  text,
  completed,
}: {
  text: string;
  completed?: boolean;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (completed) setOpen(false);
  }, [completed]);
  return (
    <div className="thinking">
      <button onClick={() => setOpen(!open)}>
        <Brain size={16} />
        <span>思考过程</span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && (
        <div className="thinking-content">
          <Markdown content={text || "正在思考…"} />
        </div>
      )}
    </div>
  );
}
