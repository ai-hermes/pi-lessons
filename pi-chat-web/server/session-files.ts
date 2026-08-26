import { ConversationError } from "@server/errors";

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function validateSessionJsonl(content: string): string {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) throw new ConversationError("请选择非空的 Pi Session JSONL 文件。");

  const entries = lines.map((line, index) => {
    try {
      const value = JSON.parse(index === 0 ? line.replace(/^\uFEFF/, "") : line) as unknown;
      if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") throw new Error("Invalid entry");
      return value as { type: string; id?: unknown };
    } catch {
      throw new ConversationError(`第 ${index + 1} 行不是有效的 Pi Session JSONL。`);
    }
  });

  const header = entries[0];
  if (header.type !== "session" || typeof header.id !== "string" || !header.id.trim()) {
    throw new ConversationError("文件缺少有效的 Pi Session 头信息。");
  }
  if (entries.slice(1).some((entry) => entry.type === "session")) {
    throw new ConversationError("文件包含重复的 Pi Session 头信息。");
  }
  return `${lines.map((line, index) => index === 0 ? line.replace(/^\uFEFF/, "") : line).join("\n")}\n`;
}
