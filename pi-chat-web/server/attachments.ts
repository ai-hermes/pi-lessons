import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ChatImage } from "@shared/types";
import { assertInside } from "@server/config";
import { ConversationError } from "@server/errors";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 50 * 1024 * 1024;
const VISUAL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface SavedAttachment {
  path: string;
  name: string;
  type: string;
  size: number;
}

export function visualAttachments(files: File[], supported: boolean): File[] {
  if (!supported) return [];
  return files.filter((file) => VISUAL_IMAGE_TYPES.has(file.type) && file.size <= 5 * 1024 * 1024);
}

export function validateImages(files: File[]): Promise<ChatImage[]> {
  if (files.length > MAX_ATTACHMENTS) throw new ConversationError(`每条消息最多添加 ${MAX_ATTACHMENTS} 张图片。`);
  return Promise.all(files.map(async (file) => {
    if (!VISUAL_IMAGE_TYPES.has(file.type)) throw new ConversationError("仅支持 PNG、JPEG 和 WebP 图片。");
    if (file.size > 5 * 1024 * 1024) throw new ConversationError("单张图片不能超过 5 MB。", 413);
    return { type: "image" as const, mimeType: file.type, data: Buffer.from(await file.arrayBuffer()).toString("base64") };
  }));
}

export function validateAttachments(files: File[]): void {
  if (files.length > MAX_ATTACHMENTS) throw new ConversationError(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件。`);
  const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
  if (oversized) throw new ConversationError(`附件「${oversized.name}」不能超过 20 MB。`, 413);
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENTS_BYTES) {
    throw new ConversationError("单条消息的附件总大小不能超过 50 MB。", 413);
  }
}

export async function saveAttachments(workspace: string, files: File[]): Promise<SavedAttachment[]> {
  if (files.length === 0) return [];
  const directory = assertInside(workspace, join(workspace, ".pi-chat-attachments"));
  await mkdir(directory, { recursive: true });
  const saved: SavedAttachment[] = [];
  try {
    for (const file of files) {
      const name = safeAttachmentName(file.name);
      const storedName = `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`;
      const target = assertInside(directory, join(directory, storedName));
      await writeFile(target, Buffer.from(await file.arrayBuffer()));
      saved.push({
        path: `.pi-chat-attachments/${storedName}`,
        name: displayAttachmentName(file.name || name),
        type: file.type || "application/octet-stream",
        size: file.size,
      });
    }
    return saved;
  } catch (error) {
    await Promise.all(saved.map((file) => rm(join(workspace, file.path), { force: true })));
    throw error;
  }
}

export function safeAttachmentName(name: string): string {
  const clean = basename(name || "attachment")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^\.+|\.+$/g, "")
    .slice(-120);
  return clean || "attachment";
}

export function attachmentPrompt(text: string, attachments: SavedAttachment[]): string {
  const clean = text.trim();
  if (attachments.length === 0) return clean;
  const list = attachments.map((file) => `- \`${file.path}\`（原文件名：${file.name}；${file.type}；${file.size} bytes）`).join("\n");
  const note = `用户上传的附件已保存到当前 workspace，请按需使用 read/bash 等工具读取并分析：\n${list}`;
  return clean ? `${clean}\n\n${note}` : note;
}

function displayAttachmentName(name: string): string {
  return name.replace(/[\r\n`]/g, " ").trim().slice(0, 160) || "attachment";
}
