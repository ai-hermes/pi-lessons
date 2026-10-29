import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ActiveOpenSandbox } from "./sandbox/client.ts";

/** Optional host-side Skill directory mirrored into OpenSandbox. */
export interface SelectedSkill {
  /** Optional display name. Defaults to the source directory name. */
  name?: string;
  /** Absolute or process-relative host directory containing SKILL.md. */
  sourceDir: string;
}

export interface SkillSyncLimits {
  /** Maximum bytes accepted for one file. Default: 8 MiB. */
  maxFileBytes?: number;
  /** Maximum bytes accepted across all selected Skills. Default: 128 MiB. */
  maxTotalBytes?: number;
  /** Maximum number of regular files. Default: 10,000. */
  maxFiles?: number;
}

export interface SkillSyncReport {
  bytes: number;
  files: number;
  remoteRoot: string;
  skills: Array<{
    digest: string;
    name: string;
    skillFile: string;
  }>;
}

interface ManifestFile {
  absoluteSource: string;
  bytes: number;
  mode: number;
  relativePath: string;
  sha256: string;
}

export interface MaterializedSkill {
  digest: string;
  files: ManifestFile[];
  hostDir: string;
  name: string;
  skillFile: string;
}

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const DIGEST_MARKER = ".pi-skill-digest";
const UPLOAD_BATCH_SIZE = 32;
const limitsSchema = z.object({
  maxFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_FILE_BYTES),
  maxTotalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_TOTAL_BYTES),
  maxFiles: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_FILES),
});

export async function materializeSkills(
  selectedSkills: SelectedSkill[],
  sharedSkillRoot: string,
  skillSyncLimits: Required<SkillSyncLimits>,
): Promise<MaterializedSkill[]> {
  if (selectedSkills.length === 0) {
    throw new Error("At least one selected Skill is required");
  }

  await mkdir(sharedSkillRoot, { recursive: true, mode: 0o700 });
  const names = new Set<string>();
  const result: MaterializedSkill[] = [];
  let totalBytes = 0;
  let totalFiles = 0;

  for (const input of selectedSkills) {
    const sourceDir = await realpath(resolve(input.sourceDir));
    const sourceStat = await stat(sourceDir);
    if (!sourceStat.isDirectory()) throw new Error(`Skill source is not a directory: ${sourceDir}`);

    const skillMd = join(sourceDir, "SKILL.md");
    const skillMdStat = await stat(skillMd).catch(() => undefined);
    if (!skillMdStat?.isFile()) throw new Error(`Skill has no regular SKILL.md: ${sourceDir}`);

    const name = normalizeSkillName(input.name ?? basename(sourceDir));
    if (names.has(name)) throw new Error(`Duplicate selected Skill name: ${name}`);
    names.add(name);

    const files = await buildManifest(sourceDir, skillSyncLimits);
    totalBytes += files.reduce((sum, file) => sum + file.bytes, 0);
    totalFiles += files.length;
    enforceTotals(totalBytes, totalFiles, skillSyncLimits);

    const digest = digestManifest(files);
    const targetDir = join(sharedSkillRoot, `${name}-${digest.slice(0, 16)}`);
    await materializeOneSkill(targetDir, digest, files);

    result.push({
      digest,
      files: files.map((file) => ({
        ...file,
        absoluteSource: join(targetDir, ...file.relativePath.split("/")),
      })),
      hostDir: targetDir,
      name,
      skillFile: join(targetDir, "SKILL.md"),
    });
  }

  return result;
}

async function buildManifest(
  root: string,
  skillSyncLimits: Required<SkillSyncLimits>,
): Promise<ManifestFile[]> {
  const files: ManifestFile[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");

      // Keep common host-only or secret-bearing files out of the sandbox bundle.
      if (isExcluded(relativePath)) continue;

      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        throw new Error(`Skill contains a symbolic link, which is not allowed: ${absolutePath}`);
      }
      if (info.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(`Skill contains a non-regular file: ${absolutePath}`);
      }
      if (info.size > skillSyncLimits.maxFileBytes) {
        throw new Error(
          `Skill file exceeds ${skillSyncLimits.maxFileBytes} bytes: ${absolutePath}`,
        );
      }
      if (files.length + 1 > skillSyncLimits.maxFiles) {
        throw new Error(
          `Selected Skills exceed the ${skillSyncLimits.maxFiles}-file limit`,
        );
      }

      const data = await readFile(absolutePath);
      files.push({
        absoluteSource: absolutePath,
        bytes: data.byteLength,
        mode: normalizeMode(info.mode),
        relativePath,
        sha256: sha256(data),
      });
    }
  }

  await visit(root);
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    throw new Error(`Skill manifest has no SKILL.md: ${root}`);
  }
  return files;
}

async function materializeOneSkill(
  targetDir: string,
  digest: string,
  files: ManifestFile[],
): Promise<void> {
  await withMaterializationLock(targetDir, async () => {
    if (await skillCacheMatchesManifest(targetDir, digest, files)) return;

    const temporaryDir = `${targetDir}.tmp-${process.pid}-${randomUUID()}`;
    await mkdir(temporaryDir, { recursive: false, mode: 0o700 });

    try {
      for (const file of files) {
        const target = join(temporaryDir, ...file.relativePath.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(file.absoluteSource, target);
        await chmod(target, file.mode);
        const copied = await readFile(target);
        if (copied.byteLength !== file.bytes || sha256(copied) !== file.sha256) {
          throw new Error(`Skill source changed while being materialized: ${file.absoluteSource}`);
        }
      }
      await writeFile(join(temporaryDir, DIGEST_MARKER), `${digest}\n`, { mode: 0o600 });
      await rm(targetDir, { recursive: true, force: true });
      await rename(temporaryDir, targetDir);
    } catch (error) {
      await rm(temporaryDir, { recursive: true, force: true });
      throw error;
    }
  });
}

async function skillCacheMatchesManifest(
  targetDir: string,
  digest: string,
  files: ManifestFile[],
): Promise<boolean> {
  try {
    const rootInfo = await lstat(targetDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    const actualFiles = new Map<string, { mode: number; size: number }>();
    async function visit(directory: string, prefix = ""): Promise<boolean> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) return false;
        if (info.isDirectory()) {
          if (!(await visit(path, relativePath))) return false;
        } else if (info.isFile()) {
          actualFiles.set(relativePath, { mode: info.mode, size: info.size });
        } else {
          return false;
        }
      }
      return true;
    }

    if (!(await visit(targetDir)) || actualFiles.size !== files.length + 1) return false;
    const markerInfo = actualFiles.get(DIGEST_MARKER);
    if (!markerInfo) return false;
    if ((await readFile(join(targetDir, DIGEST_MARKER), "utf8")).trim() !== digest) return false;

    for (const expected of files) {
      const info = actualFiles.get(expected.relativePath);
      if (!info || info.size !== expected.bytes || normalizeMode(info.mode) !== expected.mode) return false;
      const path = join(targetDir, ...expected.relativePath.split("/"));
      if (sha256(await readFile(path)) !== expected.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function uploadSkills(
  activeSandbox: ActiveOpenSandbox,
  skills: MaterializedSkill[],
  sharedSkillRoot: string,
  skillSyncLimits: Required<SkillSyncLimits>,
  verifyUploadedSkills: boolean,
): Promise<SkillSyncReport> {
  if (!activeSandbox.readableResourceRoots.includes(sharedSkillRoot)) {
    throw new Error(
      `OpenSandbox resourceRoots does not contain the Skill root: ${sharedSkillRoot}`,
    );
  }

  const uploads = skills.flatMap((skill) => {
    const remoteSkillDir = skill.hostDir.split(sep).join("/");
    return skill.files.map((file) => ({
      file,
      remotePath: joinPosix(remoteSkillDir, file.relativePath),
    }));
  });
  const bytes = uploads.reduce((sum, upload) => sum + upload.file.bytes, 0);
  enforceTotals(bytes, uploads.length, skillSyncLimits);

  const directories = [...new Set([
    sharedSkillRoot,
    ...skills.map((skill) => skill.hostDir.split(sep).join("/")),
    ...uploads.map((upload) => dirnamePosix(upload.remotePath)),
  ])];
  for (const batch of batches(directories, UPLOAD_BATCH_SIZE)) {
    await activeSandbox.ensureSandboxDirectories(batch);
  }

  for (const batch of batches(uploads, UPLOAD_BATCH_SIZE)) {
    const entries = await Promise.all(batch.map(async ({ file, remotePath }) => ({
      path: remotePath,
      data: await readFile(file.absoluteSource),
      mode: file.mode,
    })));
    await activeSandbox.writeSandboxFiles(entries);
  }

  if (verifyUploadedSkills) {
    for (const batch of batches(uploads, UPLOAD_BATCH_SIZE)) {
      await Promise.all(batch.map(async ({ file, remotePath }) => {
        const remoteDigest = await activeSandbox.hashSandboxFile(
          remotePath,
          skillSyncLimits.maxFileBytes,
        );
        if (remoteDigest !== file.sha256) {
          throw new Error(`Remote Skill verification failed: ${remotePath}`);
        }
      }));
    }
  }

  return {
    bytes,
    files: uploads.length,
    remoteRoot: sharedSkillRoot,
    skills: skills.map((skill) => ({
      digest: skill.digest,
      name: skill.name,
      skillFile: skill.skillFile.split(sep).join("/"),
    })),
  };
}

export function parseSharedSkillRoot(value: string): string {
  if (process.platform === "win32") {
    throw new Error("Same-path Skill mirroring requires a POSIX host; use an explicit host/remote path mapper on Windows");
  }
  const normalized = resolve(value);
  if (!isAbsolute(value) || normalized !== value || value === "/") {
    throw new Error("sharedSkillRoot must be a normalized, non-root absolute POSIX path");
  }
  if (!value.split("/").includes("skills")) {
    throw new Error("sharedSkillRoot must be a task-scoped path containing a 'skills' segment");
  }
  return value;
}

export function parseSkillSyncLimits(
  input: SkillSyncLimits | undefined,
): Required<SkillSyncLimits> {
  return limitsSchema.parse(input ?? {});
}

function enforceTotals(
  bytes: number,
  files: number,
  skillSyncLimits: Required<SkillSyncLimits>,
): void {
  if (bytes > skillSyncLimits.maxTotalBytes) {
    throw new Error(
      `Selected Skills exceed the ${skillSyncLimits.maxTotalBytes}-byte total limit`,
    );
  }
  if (files > skillSyncLimits.maxFiles) {
    throw new Error(
      `Selected Skills exceed the ${skillSyncLimits.maxFiles}-file limit`,
    );
  }
}

function normalizeSkillName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error(`Invalid Skill name: ${value}`);
  }
  return normalized.slice(0, 80);
}

function normalizeMode(mode: number): number {
  // Preserve executability but remove setuid/setgid/sticky and group/world writes.
  return (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

function digestManifest(files: ManifestFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.mode.toString(8));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isExcluded(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split("/");
  const base = segments.at(-1) ?? "";
  return segments.includes(".git")
    || segments.includes("node_modules")
    || base.startsWith(".env")
    || base.endsWith(".pem")
    || base.endsWith(".key")
    || base === DIGEST_MARKER;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function dirnamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

async function withMaterializationLock<T>(targetDir: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${targetDir}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  let handle;
  for (let attempt = 0; ; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(owner);
      break;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await rm(lockPath, { force: true });
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const currentOwner = await readFile(lockPath, "utf8").catch(() => "");
      const pid = Number.parseInt(currentOwner.split(":", 1)[0] ?? "", 10);
      if (Number.isSafeInteger(pid) && !processExists(pid)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (attempt >= 2400) throw new Error(`Timed out waiting to materialize Skill: ${targetDir}`);
      await delay(50);
    }
  }
  try {
    return await action();
  } finally {
    await handle?.close();
    if (await readFile(lockPath, "utf8").catch(() => "") === owner) {
      await rm(lockPath, { force: true });
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}
