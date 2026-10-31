import {
  ConnectionConfig,
  Sandbox,
  type ExecutionHandlers,
  type FileInfo,
  type SandboxConnectOptions,
  type SandboxCreateOptions,
  type WriteEntry,
} from "@alibaba-group/opensandbox";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { join as joinPosix, normalize as normalizePosix } from "node:path/posix";
import type { OpenSandboxSettings } from "./config";
import { describeOpenSandboxError, logOpenSandboxEvent } from "./logger";

/** How an active sandbox client was obtained. */
export type SandboxStartupMode = "connected" | "created" | "resumed";

/** Resource action performed when an active sandbox is released. */
export type SandboxReleaseMode = "disconnect" | "kill" | "pause";

interface ActiveOpenSandboxInit {
  defaultCommandTimeoutSeconds: number;
  hostWorkspaceRoot: string;
  imageReference: string;
  maxFileReadBytes: number;
  readableResourceRoots: string[];
  sandboxClient: Sandbox;
  sandboxWorkspaceRoot: string;
  startupMode: SandboxStartupMode;
  owned: boolean;
}

/**
 * Persisted sandbox identity and ownership used when restoring a Pi session.
 *
 * @example
 * ```ts
 * const target: SandboxRestoreTarget = {
 *   sandboxId: "sandbox-123",
 *   owned: true,
 * };
 * ```
 */
export interface SandboxRestoreTarget {
  /** Persisted sandbox identifier from the Pi session state. */
  sandboxId: string;
  /** Whether this extension owns the sandbox lifecycle. */
  owned: boolean;
}

/** Optional execution controls for a remote shell command. */
export interface SandboxCommandOptions {
  /** Collect stdout and stderr in the returned result. */
  captureOutput?: boolean;
  /** Environment variables forwarded to the remote process. */
  env?: NodeJS.ProcessEnv;
  /** Maximum captured bytes before output is marked as truncated. */
  maxOutputBytes?: number;
  /** Receives stdout and stderr chunks as they arrive. */
  onData?: (data: Buffer) => void;
  /** Interrupts the remote process when aborted. */
  signal?: AbortSignal;
  /** Overrides the configured command timeout. */
  timeoutSeconds?: number;
}

/** Result returned after a remote command exits. */
export interface SandboxCommandResult {
  /** Remote process exit code, or `null` when unavailable. */
  exitCode: number | null;
  /** Captured output when `captureOutput` was enabled. */
  output: string;
  /** Whether captured output exceeded `maxOutputBytes`. */
  outputTruncated: boolean;
}

/**
 * Provides path-safe file, command, endpoint, and lifecycle access to one sandbox.
 *
 * Host paths are accepted only when they resolve inside the host workspace.
 * Absolute sandbox paths are accepted only inside the configured workspace or
 * readable resource roots.
 *
 * @example
 * ```ts
 * const sandbox = await ActiveOpenSandbox.start(
 *   settings,
 *   process.cwd(),
 *   "pi-session-123",
 * );
 * const result = await sandbox.runCommand("node --version", "/workspace", {
 *   captureOutput: true,
 * });
 * await sandbox.release("pause");
 * ```
 */
export class ActiveOpenSandbox {
  readonly defaultCommandTimeoutSeconds: number;
  readonly hostWorkspaceRoot: string;
  readonly imageReference: string;
  readonly maxFileReadBytes: number;
  readonly readableResourceRoots: readonly string[];
  readonly sandboxWorkspaceRoot: string;
  readonly startupMode: SandboxStartupMode;
  readonly isOwnedByExtension: boolean;
  private readonly sandboxClient: Sandbox;

  constructor(init: ActiveOpenSandboxInit) {
    this.defaultCommandTimeoutSeconds = init.defaultCommandTimeoutSeconds;
    this.hostWorkspaceRoot = resolve(init.hostWorkspaceRoot);
    this.imageReference = init.imageReference;
    this.maxFileReadBytes = init.maxFileReadBytes;
    this.readableResourceRoots = Object.freeze([...init.readableResourceRoots]);
    this.sandboxClient = init.sandboxClient;
    this.sandboxWorkspaceRoot = init.sandboxWorkspaceRoot;
    this.startupMode = init.startupMode;
    this.isOwnedByExtension = init.owned;
  }

  static async start(
    sandboxSettings: OpenSandboxSettings,
    hostWorkspaceRoot: string,
    sessionId: string,
    restoreTarget?: SandboxRestoreTarget,
  ): Promise<ActiveOpenSandbox> {
    const connectionConfigOptions = {
      domain: sandboxSettings.domain,
      protocol: sandboxSettings.protocol,
      requestTimeoutSeconds: sandboxSettings.requestTimeoutSeconds,
      useServerProxy: sandboxSettings.useServerProxy,
      ...(sandboxSettings.apiKey !== undefined ? { apiKey: sandboxSettings.apiKey } : {}),
    };
    const sandboxId = restoreTarget?.sandboxId ?? sandboxSettings.sandboxId;
    const connected = sandboxId
      ? await connectOrResumeSandbox(connectionConfigOptions, sandboxId)
      : {
        sandboxClient: await Sandbox.create(buildSandboxCreateOptions(
          new ConnectionConfig(connectionConfigOptions),
          sandboxSettings,
          sessionId,
        )),
        startupMode: "created" as const,
      };
    const activeSandbox = new ActiveOpenSandbox({
      defaultCommandTimeoutSeconds: sandboxSettings.commandTimeoutSeconds,
      hostWorkspaceRoot,
      imageReference: sandboxSettings.image ?? sandboxSettings.snapshotId ?? "existing sandbox",
      maxFileReadBytes: sandboxSettings.maxReadBytes,
      readableResourceRoots: sandboxSettings.resourceRoots,
      sandboxClient: connected.sandboxClient,
      sandboxWorkspaceRoot: sandboxSettings.workspace,
      startupMode: connected.startupMode,
      owned: restoreTarget?.owned ?? sandboxId === undefined,
    });

    try {
      await activeSandbox.ensureSandboxDirectories([activeSandbox.sandboxWorkspaceRoot]);
      return activeSandbox;
    } catch (error) {
      logOpenSandboxEvent("error", "sandbox.workspace.initialize.error", {
        sandboxId: activeSandbox.id,
        ...describeOpenSandboxError(error),
      });
      await activeSandbox.cleanupAfterStartFailure();
      throw error;
    }
  }

  get id(): string {
    return this.sandboxClient.id;
  }

  /** Maps a host workspace path or approved sandbox resource path for reading. */
  resolveReadablePath(inputPath: string): string {
    this.assertSupportedInputPath(inputPath);
    const sandboxCandidate = inputPath.replace(/\\/g, "/");
    if (sandboxCandidate.startsWith("/")) {
      const normalizedSandboxPath = normalizePosix(sandboxCandidate);
      if (this.isReadableSandboxPath(normalizedSandboxPath)) {
        return normalizedSandboxPath;
      }
    }
    return this.mapWorkspacePathToSandbox(inputPath);
  }

  /** Maps a host workspace path for writes, which are restricted to the workspace. */
  resolveWritablePath(inputPath: string): string {
    this.assertSupportedInputPath(inputPath);
    const sandboxCandidate = inputPath.replace(/\\/g, "/");
    if (sandboxCandidate.startsWith("/")) {
      const normalizedSandboxPath = normalizePosix(sandboxCandidate);
      if (isWithin(this.sandboxWorkspaceRoot, normalizedSandboxPath)) {
        return normalizedSandboxPath;
      }
    }
    return this.mapWorkspacePathToSandbox(inputPath);
  }

  /** Executes a command without allowing captured output to grow unbounded. */
  async runCommand(
    command: string,
    sandboxWorkingDirectory: string,
    options: SandboxCommandOptions = {},
  ): Promise<SandboxCommandResult> {
    if (options.signal?.aborted) throw new Error("Command aborted");

    let executionId: string | undefined;
    let output = "";
    let outputTruncated = false;
    const captureOutput = options.captureOutput === true;
    const maximumBytes = Math.max(0, Math.floor(options.maxOutputBytes ?? Number.MAX_SAFE_INTEGER));
    let outputBytes = 0;
    const capture = (text: string) => {
      if (!captureOutput || outputTruncated) return;
      const data = Buffer.from(text);
      const remaining = maximumBytes - outputBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      if (data.byteLength <= remaining) {
        output += text;
        outputBytes += data.byteLength;
      } else {
        output += data.subarray(0, remaining).toString();
        outputBytes += remaining;
        outputTruncated = true;
      }
    };
    const onAbort = () => {
      if (executionId) {
        this.sandboxClient.commands.interrupt(executionId).catch(() => undefined);
      }
    };
    const handlers: ExecutionHandlers = {
      onInit: (event) => {
        executionId = event.id;
      },
      onStdout: (event) => {
        capture(event.text);
        options.onData?.(Buffer.from(event.text));
      },
      onStderr: (event) => {
        capture(event.text);
        options.onData?.(Buffer.from(event.text));
      },
      skipAccumulation: true,
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const envs = Object.fromEntries(
        Object
          .entries(options.env ?? {})
          .filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          ),
      );
      const execution = await this.sandboxClient.commands.run(
        command,
        {
          workingDirectory: sandboxWorkingDirectory,
          timeoutSeconds: options.timeoutSeconds ?? this.defaultCommandTimeoutSeconds,
          ...(Object.keys(envs).length > 0 ? { envs } : {}),
        },
        handlers,
        options.signal,
      );
      if (options.signal?.aborted) {
        throw new Error("Command aborted");
      }
      return {
        exitCode: execution.exitCode ?? null,
        output,
        outputTruncated
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async readFile(inputPath: string): Promise<Buffer> {
    return this.readSandboxFile(this.resolveReadablePath(inputPath), this.maxFileReadBytes);
  }

  async getFileInfo(inputPath: string): Promise<FileInfo | undefined> {
    const sandboxPath = this.resolveReadablePath(inputPath);
    const metadata = await this.sandboxClient.files.getFileInfo([sandboxPath]);
    return metadata[sandboxPath];
  }

  async searchFiles(inputPath: string, pattern: string): Promise<FileInfo[]> {
    return this.sandboxClient.files.search({
      path: this.resolveReadablePath(inputPath),
      pattern,
    });
  }

  async createDirectory(inputPath: string): Promise<void> {
    const sandboxPath = this.resolveWritablePath(inputPath);
    await this.sandboxClient.files.createDirectories([{ path: sandboxPath }]);
  }

  async writeFile(
    inputPath: string,
    data: NonNullable<WriteEntry["data"]>,
  ): Promise<void> {
    const sandboxPath = this.resolveWritablePath(inputPath);
    await this.sandboxClient.files.createDirectories([{ path: dirnamePosix(sandboxPath) }]);
    await this.sandboxClient.files.writeFiles([{ path: sandboxPath, data }]);
  }

  async ensureSandboxDirectories(sandboxPaths: string[]): Promise<void> {
    for (const sandboxPath of sandboxPaths) this.assertManagedSandboxPath(sandboxPath);
    await this.sandboxClient.files.createDirectories(
      sandboxPaths.map((sandboxPath) => ({ path: sandboxPath })),
    );
  }

  async writeSandboxFiles(entries: WriteEntry[]): Promise<void> {
    for (const entry of entries) this.assertManagedSandboxPath(entry.path);
    await this.sandboxClient.files.writeFiles(entries);
  }

  async hashSandboxFile(sandboxPath: string, maximumBytes: number): Promise<string> {
    const data = await this.readSandboxFile(sandboxPath, maximumBytes);
    return createHash("sha256").update(data).digest("hex");
  }

  async getEndpointUrl(port: number): Promise<string> {
    return this.sandboxClient.getEndpointUrl(port);
  }

  async renew(timeoutSeconds: number): Promise<void> {
    await this.sandboxClient.renew(timeoutSeconds);
  }

  /**
   * Releases the remote resource and always closes the local transport.
   *
   * `disconnect` closes only the transport; `pause` and `kill` also change the
   * server-side sandbox lifecycle.
   */
  async release(mode: SandboxReleaseMode): Promise<void> {
    try {
      if (mode === "pause") await this.sandboxClient.pause();
      else if (mode === "kill") await this.sandboxClient.kill();
    } finally {
      await this.sandboxClient.close().catch((error) => {
        logOpenSandboxEvent("error", "sandbox.close.transport.error", {
          sandboxId: this.id,
          ...describeOpenSandboxError(error),
        });
      });
    }
  }

  /** Performs best-effort cleanup after startup or initialization fails. */
  async cleanupAfterStartFailure(): Promise<void> {
    if (this.isOwnedByExtension) {
      const action = this.startupMode === "created" ? "kill" : "pause";
      await this.sandboxClient[action]().catch((error) => {
        logOpenSandboxEvent("error", `sandbox.cleanup.${action}.error`, {
          sandboxId: this.id,
          ...describeOpenSandboxError(error),
        });
      });
    }
    await this.sandboxClient.close().catch((error) => {
      logOpenSandboxEvent("error", "sandbox.cleanup.close.error", {
        sandboxId: this.id,
        ...describeOpenSandboxError(error),
      });
    });
  }

  private async readSandboxFile(sandboxPath: string, maximumBytes: number): Promise<Buffer> {
    this.assertManagedSandboxPath(sandboxPath);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of this.sandboxClient.files.readBytesStream(sandboxPath)) {
      if (chunk.byteLength > maximumBytes - totalBytes) {
        throw new Error(`File exceeds the ${maximumBytes}-byte OpenSandbox read limit`);
      }
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      totalBytes += buffer.byteLength;
    }
    return Buffer.concat(chunks, totalBytes);
  }

  private assertSupportedInputPath(inputPath: string): void {
    const normalizedInput = inputPath.replace(/\\/g, "/");
    if (
      normalizedInput === "~"
      || normalizedInput.startsWith("~/")
      || normalizedInput.startsWith("@")
      || normalizedInput.startsWith("file:")
      || /^[a-zA-Z]:\//.test(normalizedInput)
      || normalizedInput.split("/").includes("..")
    ) {
      throw new Error(
        "OpenSandbox tools accept only paths inside the task workspace or configured resource roots",
      );
    }
  }

  private mapWorkspacePathToSandbox(inputPath: string): string {
    // Normalize the input into an absolute host path, resolving "." and ".." lexically.
    // Example: root "/project" + "src/../README.md" -> "/project/README.md".
    const hostPath = inputPath.replace(/\\/g, sep);
    const resolvedHostPath = resolve(this.hostWorkspaceRoot, hostPath);

    // Convert it back to a workspace-relative path so paths outside the host
    // workspace can be detected before mapping them into the Sandbox.
    // Valid:   "/project/README.md" -> "README.md".
    // Invalid: root "/project" + "../etc/passwd" -> "/etc/passwd"
    //          -> "../etc/passwd", which is rejected below.
    const relativeHostPath = relative(this.hostWorkspaceRoot, resolvedHostPath);
    if (relativeHostPath === "") return this.sandboxWorkspaceRoot;
    if (
      relativeHostPath === ".."
      || relativeHostPath.startsWith(`..${sep}`)
      || isAbsolute(relativeHostPath)
    ) {
      throw new Error(`Path escapes the host workspace: ${inputPath}`);
    }

    // Rebase the validated relative path under the Sandbox workspace root.
    return joinPosix(this.sandboxWorkspaceRoot, ...relativeHostPath.split(sep));
  }

  private assertManagedSandboxPath(sandboxPath: string): void {
    const normalizedSandboxPath = normalizePosix(sandboxPath.replace(/\\/g, "/"));
    if (
      !sandboxPath.startsWith("/")
      || normalizedSandboxPath !== sandboxPath
      || !this.isReadableSandboxPath(normalizedSandboxPath)
    ) {
      throw new Error(`Sandbox path is outside the managed roots: ${sandboxPath}`);
    }
  }

  private isReadableSandboxPath(sandboxPath: string): boolean {
    return isWithin(this.sandboxWorkspaceRoot, sandboxPath)
      || this.readableResourceRoots.some((root) => isWithin(root, sandboxPath));
  }
}

/** Indicates that neither connecting nor resuming found the requested sandbox. */
export class OpenSandboxNotFoundError extends Error {
  constructor(readonly sandboxId: string) {
    super(`OpenSandbox ${sandboxId} was not found`);
    this.name = "OpenSandboxNotFoundError";
  }
}

/**
 * Quotes a value as one literal POSIX shell argument.
 *
 * Single quotes preserve spaces and shell metacharacters, but a single-quoted
 * string cannot contain another single quote. Each `'` is therefore replaced
 * with `'\''`: close the quoted string, emit an escaped quote, then reopen it.
 *
 * @example
 * ```ts
 * shellQuote("it's ready");
 * // => `'it'\''s ready'`
 * ```
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildSandboxCreateOptions(
  connectionConfig: ConnectionConfig,
  sandboxSettings: OpenSandboxSettings,
  sessionId: string,
): SandboxCreateOptions {
  return {
    connectionConfig,
    timeoutSeconds: sandboxSettings.timeoutSeconds,
    readyTimeoutSeconds: sandboxSettings.readyTimeoutSeconds,
    metadata: {
      ...sandboxSettings.metadata,
      "pi-extension": "opensandbox",
      "pi-session-id": sessionId,
    },
    networkPolicy: sandboxSettings.networkPolicy
      ?? (sandboxSettings.networkAllowlist.length === 0
        ? { defaultAction: "allow" }
        : {
            defaultAction: "deny",
            egress: sandboxSettings.networkAllowlist.map((target) => ({ action: "allow", target })),
          }),
    ...(sandboxSettings.entrypoint !== undefined ? { entrypoint: sandboxSettings.entrypoint } : {}),
    ...(sandboxSettings.env !== undefined ? { env: sandboxSettings.env } : {}),
    ...(sandboxSettings.image !== undefined ? { image: sandboxSettings.image } : {}),
    ...(sandboxSettings.snapshotId !== undefined ? { snapshotId: sandboxSettings.snapshotId } : {}),
    ...(sandboxSettings.resource !== undefined ? { resource: sandboxSettings.resource } : {}),
    ...(sandboxSettings.resourceRequests !== undefined
      ? { resourceRequests: sandboxSettings.resourceRequests }
      : {}),
    ...(sandboxSettings.volumes !== undefined ? { volumes: sandboxSettings.volumes } : {}),
  };
}

function isWithin(root: string, candidate: string): boolean {
  return root === "/"
    ? candidate.startsWith("/")
    : candidate === root || candidate.startsWith(`${root}/`);
}

async function connectOrResumeSandbox(
  connectionConfigOptions: ConstructorParameters<typeof ConnectionConfig>[0],
  sandboxId: SandboxConnectOptions["sandboxId"],
): Promise<{
  sandboxClient: Sandbox;
  startupMode: Extract<SandboxStartupMode, "connected" | "resumed">;
}> {
  const options = {
    connectionConfig: new ConnectionConfig(connectionConfigOptions),
    sandboxId,
  };
  try {
    return { sandboxClient: await Sandbox.connect(options), startupMode: "connected" };
  } catch (connectError) {
    try {
      return { sandboxClient: await Sandbox.resume(options), startupMode: "resumed" };
    } catch (resumeError) {
      if (isNotFound(connectError) && isNotFound(resumeError)) {
        throw new OpenSandboxNotFoundError(String(sandboxId));
      }
      throw new Error(
        `Unable to connect to OpenSandbox ${sandboxId}: ${getErrorMessage(connectError)}; `
        + `resume also failed: ${getErrorMessage(resumeError)}`,
      );
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "statusCode" in error
    && (error as { statusCode?: unknown }).statusCode === 404;
}

function dirnamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
