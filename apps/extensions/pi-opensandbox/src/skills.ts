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
import { shellQuote, type ActiveOpenSandbox } from "./sandbox/client";

/**
 * Host-side Skill directory selected for upload into OpenSandbox.
 *
 * @example
 * ```ts
 * const skill: SelectedSkill = {
 *   name: "code-review",
 *   sourceDir: "/home/user/.pi/skills/code-review",
 * };
 * ```
 */
export interface SelectedSkill {
  /** Optional display name. Defaults to the source directory name. */
  name?: string;
  /** Absolute or process-relative host directory containing SKILL.md. */
  sourceDir: string;
}

/** Safety limits applied while scanning, caching, and uploading Skills. */
export interface SkillSyncLimits {
  /** Maximum bytes accepted for one file. Default: 8 MiB. */
  maxFileBytes?: number;
  /** Maximum bytes accepted across all selected Skills. Default: 128 MiB. */
  maxTotalBytes?: number;
  /** Maximum number of regular files. Default: 10,000. */
  maxFiles?: number;
}

/** Summary of Skill content uploaded to the active sandbox. */
export interface SkillSyncReport {
  /** Total uploaded payload size. */
  bytes: number;
  /** Number of uploaded regular files. */
  files: number;
  /** Sandbox root containing the uploaded Skills. */
  remoteRoot: string;
  /** Content identity and entry point for each uploaded Skill. */
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

/**
 * Content-addressed host copy of one selected Skill.
 *
 * The materialized copy prevents source changes during upload.
 */
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
const REMOTE_MANIFEST = ".pi-skills-manifest.json";
const UPLOAD_BATCH_SIZE = 32;
const limitsSchema = z.object({
  maxFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_FILE_BYTES),
  maxTotalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_TOTAL_BYTES),
  maxFiles: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_FILES),
});

/**
 * Validates selected Skills and creates content-addressed host copies.
 *
 * Symbolic links, non-regular files, common secret files, and content exceeding
 * the configured limits are rejected before any remote upload occurs.
 *
 * @example
 * ```ts
 * const limits = parseSkillSyncLimits(undefined);
 * const skills = await materializeSkills(
 *   [{ sourceDir: "/home/user/.pi/skills/code-review" }],
 *   "/tmp/pi/skills",
 *   limits,
 * );
 * ```
 */
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

/**
 * Uploads materialized Skills below the configured remote root.
 *
 * When verification is enabled, every remote file is hashed after upload and
 * compared with its host manifest digest.
 *
 * @example
 * ```ts
 * const report = await uploadSkills(
 *   activeSandbox,
 *   skills,
 *   "/tmp/pi/skills",
 *   parseSkillSyncLimits(undefined),
 *   true,
 * );
 * ```
 */
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

  const stagingRoot = joinPosix(sharedSkillRoot, `.staging-${randomUUID()}`);
  const uploads = skills.flatMap((skill) => {
    const remoteSkillDir = joinPosix(stagingRoot, skill.name);
    return skill.files.map((file) => ({
      file,
      remotePath: joinPosix(remoteSkillDir, file.relativePath),
    }));
  });
  const bytes = uploads.reduce((sum, upload) => sum + upload.file.bytes, 0);
  enforceTotals(bytes, uploads.length, skillSyncLimits);
  const manifest = Buffer.from(`${JSON.stringify({
    version: 1,
    skills: Object.fromEntries(skills.map((skill) => [
      skill.name,
      {
        digest: skill.digest,
        skillFile: `${skill.name}/SKILL.md`,
      },
    ])),
  }, null, 2)}\n`);
  const remoteManifest = joinPosix(stagingRoot, REMOTE_MANIFEST);

  const directories = [...new Set([
    sharedSkillRoot,
    stagingRoot,
    ...skills.map((skill) => joinPosix(stagingRoot, skill.name)),
    ...uploads.map((upload) => dirnamePosix(upload.remotePath)),
  ])];

  try {
    for (const batch of batches(directories, UPLOAD_BATCH_SIZE)) {
      await activeSandbox.ensureSandboxDirectories(batch);
    }

    for (const batch of batches(uploads, UPLOAD_BATCH_SIZE)) {
      const entries = await Promise.all(batch.map(async ({ file, remotePath }) => ({
        path: remotePath,
        data: await readFile(file.absoluteSource),
        mode: toSandboxMode(file.mode),
      })));
      await writeSandboxFilesWithRetry(activeSandbox, entries);
    }

    await writeSandboxFilesWithRetry(activeSandbox, [{
      path: remoteManifest,
      data: manifest,
      mode: 600,
    }]);

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
      if (
        await activeSandbox.hashSandboxFile(remoteManifest, manifest.byteLength)
        !== sha256(manifest)
      ) {
        throw new Error(`Remote Skill verification failed: ${remoteManifest}`);
      }
    }

    await commitRemoteSkills(activeSandbox, sharedSkillRoot, stagingRoot, skills);
  } catch (error) {
    await removeRemotePath(activeSandbox, stagingRoot);
    throw error;
  }

  return {
    bytes,
    files: uploads.length,
    remoteRoot: sharedSkillRoot,
    skills: skills.map((skill) => ({
      digest: skill.digest,
      name: skill.name,
      skillFile: joinPosix(sharedSkillRoot, skill.name, "SKILL.md"),
    })),
  };
}

async function commitRemoteSkills(
  activeSandbox: ActiveOpenSandbox,
  sharedSkillRoot: string,
  stagingRoot: string,
  skills: MaterializedSkill[],
): Promise<void> {
  const backupRoot = joinPosix(sharedSkillRoot, `.previous-${randomUUID()}`);
  const replacements = [
    ...skills.map((skill) => skill.name),
    REMOTE_MANIFEST,
  ];
  const rollback = replacements.flatMap((name) => {
    const current = joinPosix(sharedSkillRoot, name);
    const backup = joinPosix(backupRoot, name);
    return [
      `rm -rf ${shellQuote(current)}`,
      `if [ -e ${shellQuote(backup)} ]; then mv ${shellQuote(backup)} ${shellQuote(current)}; fi`,
    ];
  });
  const replace = replacements.flatMap((name) => {
    const current = joinPosix(sharedSkillRoot, name);
    const staged = joinPosix(stagingRoot, name);
    const backup = joinPosix(backupRoot, name);
    return [
      `if [ -e ${shellQuote(current)} ]; then mv ${shellQuote(current)} ${shellQuote(backup)}; fi`,
      `mv ${shellQuote(staged)} ${shellQuote(current)}`,
    ];
  });
  const retained = replacements.map((name) => shellQuote(joinPosix(sharedSkillRoot, name))).join("|");
  const command = [
    "set -eu",
    `mkdir -p ${shellQuote(backupRoot)}`,
    "rollback() {",
    "status=$?",
    "trap - EXIT HUP INT TERM",
    "if [ \"$status\" -ne 0 ]; then",
    ...rollback,
    `rm -rf ${shellQuote(backupRoot)}`,
    "fi",
    "exit \"$status\"",
    "}",
    "trap rollback EXIT HUP INT TERM",
    ...replace,
    "trap - EXIT HUP INT TERM",
    `for entry in ${shellQuote(sharedSkillRoot)}/* ${shellQuote(sharedSkillRoot)}/.[!.]* ${shellQuote(sharedSkillRoot)}/..?*; do`,
    "[ -e \"$entry\" ] || continue",
    `case "$entry" in ${retained}) ;; *) rm -rf "$entry" ;; esac`,
    "done",
  ].join("\n");
  const result = await activeSandbox.runCommand(
    command,
    activeSandbox.sandboxWorkspaceRoot,
    { captureOutput: true },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Remote Skill activation failed${result.output ? `: ${result.output.trim()}` : ""}`,
    );
  }
}

async function removeRemotePath(
  activeSandbox: ActiveOpenSandbox,
  remotePath: string,
): Promise<void> {
  await activeSandbox.runCommand(
    `rm -rf ${shellQuote(remotePath)}`,
    activeSandbox.sandboxWorkspaceRoot,
  ).catch(() => undefined);
}

/**
 * Validates the POSIX root used for uploaded remote Skills.
 *
 * @example
 * ```ts
 * const root = parseSharedSkillRoot("/tmp/pi/skills");
 * ```
 */
export function parseSharedSkillRoot(value: string): string {
  if (process.platform === "win32") {
    throw new Error("sharedSkillRoot must use an absolute POSIX path");
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

/**
 * Applies defaults and validates Skill synchronization limits.
 *
 * @example
 * ```ts
 * const limits = parseSkillSyncLimits({ maxFiles: 500 });
 * ```
 */
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

function toSandboxMode(mode: number): number {
  return Number.parseInt((mode & 0o777).toString(8), 10);
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
      // A crashed materializer cannot remove its lock, so another process may
      // reclaim it only after confirming that the recorded PID no longer exists.
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

async function writeSandboxFilesWithRetry(
  activeSandbox: ActiveOpenSandbox,
  entries: Parameters<ActiveOpenSandbox["writeSandboxFiles"]>[0],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await activeSandbox.writeSandboxFiles(entries);
      return;
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode;
      if (
        attempt >= 2
        || typeof statusCode !== "number"
        || statusCode < 500
        || statusCode >= 600
      ) {
        throw error;
      }
      await delay(100 * (attempt + 1));
    }
  }
}
