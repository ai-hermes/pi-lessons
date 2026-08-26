import { mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AppPaths {
  root: string;
  appSettings: string;
  records: string;
  sessions: string;
  workspaces: string;
  exports: string;
}

export function resolvePaths(root = process.env.PI_CHAT_DATA_DIR?.trim()): AppPaths {
  const resolvedRoot = resolve(root || join(getAgentDir(), "web-chat"));
  return {
    root: resolvedRoot,
    appSettings: join(resolvedRoot, "app-settings.json"),
    records: join(resolvedRoot, "records"),
    sessions: join(resolvedRoot, "sessions"),
    workspaces: join(resolvedRoot, "workspaces"),
    exports: join(resolvedRoot, "exports"),
  };
}

export async function ensurePaths(paths: AppPaths): Promise<void> {
  await Promise.all([paths.records, paths.sessions, paths.workspaces, paths.exports].map((path) => mkdir(path, { recursive: true })));
}

export function assertInside(root: string, candidate: string): string {
  const safeRoot = resolve(root);
  const safeCandidate = resolve(candidate);
  const child = relative(safeRoot, safeCandidate);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Refusing path outside managed directory: ${safeCandidate}`);
  }
  return safeCandidate;
}

export function idleTtlMs(): number {
  const parsed = Number(process.env.PI_CHAT_IDLE_TTL_MS ?? 300_000);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 ? parsed : 300_000;
}

export const SECURITY_WARNING = "本地可信演示：Bash 可通过绝对路径访问本机文件系统，这不是 OS 级沙箱。请勿暴露到公网。";
