import { ChevronRight } from "lucide-react";
import { PiLogo } from "@components/PiLogo";
import { Button } from "@components/ui/button";

export function EmptyConversation({
  onPrompt,
}: {
  onPrompt: (text: string) => void;
}) {
  const prompts = [
    "帮我制定本周的学习计划",
    "解释一个复杂的技术概念",
    "帮我整理一份项目方案",
  ];
  return (
    <section className="empty-conversation">
      <div className="empty-icon">
        <PiLogo size={66} />
      </div>
      <h1>有什么我可以帮你？</h1>
      <p>输入你的问题，或者从试试推荐问题</p>
      <div className="prompt-list">
        {prompts.map((prompt) => (
          <Button
            variant="outline"
            key={prompt}
            onClick={() => onPrompt(prompt)}
          >
            {prompt}
            <ChevronRight size={15} />
          </Button>
        ))}
      </div>
    </section>
  );
}
