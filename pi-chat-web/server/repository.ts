import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositoryInfo } from "@shared/types";

const execFileAsync = promisify(execFile);

export async function readRepositoryInfo(cwd = process.cwd()): Promise<RepositoryInfo | undefined> {
  try {
    const [{ stdout: branch }, { stdout: commit }] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd, timeout: 1_000 }),
      execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 1_000 }),
    ]);
    return { branch: branch.trim() || "detached", commit: commit.trim() };
  } catch {
    return undefined;
  }
}
