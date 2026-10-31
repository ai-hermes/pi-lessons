import type { OpenSandboxSettings } from "./config";
import { describeOpenSandboxError, logOpenSandboxEvent } from "./logger";
import {
  ActiveOpenSandbox,
  type SandboxRestoreTarget,
} from "./client";

type SandboxStarter = (
  sandboxSettings: OpenSandboxSettings,
  hostWorkspaceRoot: string,
  sessionId: string,
  restoreTarget?: SandboxRestoreTarget,
) => Promise<ActiveOpenSandbox>;

interface SandboxSessionOptions {
  hostWorkspaceRoot: string;
  onReady?: (activeSandbox: ActiveOpenSandbox) => void | Promise<void>;
  startSandbox?: SandboxStarter;
}

/** Observable lifecycle state for one Pi session's remote sandbox. */
export type SandboxSessionMode = "local" | "restoring" | "remote" | "failed";

/**
 * Coordinates one active OpenSandbox connection for a Pi session.
 *
 * Concurrent starts share one promise. Deactivation kills sandboxes created by
 * the extension, while shutdown pauses them so a later Pi resume can restore
 * the same sandbox. Externally supplied sandboxes are only disconnected.
 *
 * @example
 * ```ts
 * const session = new SandboxSession({ hostWorkspaceRoot: process.cwd() });
 * session.setSessionContext("pi-session-123", process.cwd());
 * const sandbox = await session.startSandbox(settings);
 * await session.shutdown();
 * ```
 */
export class SandboxSession {
  private activeSandbox: ActiveOpenSandbox | null = null;
  private failure: unknown;
  private readonly onReady: SandboxSessionOptions["onReady"];
  private pending: Promise<ActiveOpenSandbox> | undefined;
  private readonly sandboxStarter: SandboxStarter;
  private hostWorkspaceRoot: string;
  private sessionId = "";
  private stopRenewal: (() => Promise<void>) | undefined;

  constructor(options: SandboxSessionOptions) {
    this.hostWorkspaceRoot = options.hostWorkspaceRoot;
    this.onReady = options.onReady;
    this.sandboxStarter = options.startSandbox ?? ActiveOpenSandbox.start;
  }

  /** Returns the live sandbox after startup and initialization complete. */
  getActiveSandbox(): ActiveOpenSandbox | null {
    return this.activeSandbox;
  }

  /** Returns the host workspace currently associated with the Pi session. */
  getHostWorkspaceRoot(): string {
    return this.hostWorkspaceRoot;
  }

  /** Derives the public mode from pending, active, and failed state. */
  getMode(): SandboxSessionMode {
    if (this.pending) return "restoring";
    if (this.activeSandbox) return "remote";
    return this.failure === undefined ? "local" : "failed";
  }

  /** Returns the most recent startup or restoration failure, if any. */
  getFailure(): unknown {
    return this.failure;
  }

  /** Clears a failure only when no start or remote connection is active. */
  clearFailure(): void {
    if (!this.pending && !this.activeSandbox) this.failure = undefined;
  }

  /** Updates identifiers that may change when Pi opens another session. */
  setSessionContext(sessionId: string, hostWorkspaceRoot: string): void {
    this.sessionId = sessionId;
    this.hostWorkspaceRoot = hostWorkspaceRoot;
  }

  /**
   * Starts, reconnects, or resumes a sandbox.
   *
   * Repeated calls return the active sandbox, and concurrent calls await the
   * same in-flight startup rather than creating duplicate sandboxes.
   */
  startSandbox(
    sandboxSettings: OpenSandboxSettings,
    restoreTarget?: SandboxRestoreTarget,
  ): Promise<ActiveOpenSandbox> {
    if (this.activeSandbox) return Promise.resolve(this.activeSandbox);
    if (this.pending) return this.pending;
    this.failure = undefined;
    const pending = this.start(sandboxSettings, restoreTarget);
    this.pending = pending;
    void pending.catch(() => undefined);
    return pending;
  }

  /**
   * Waits for startup when necessary and returns the active sandbox.
   *
   * Throws instead of falling back to host execution, preventing a remote-mode
   * tool call from accidentally running against local files.
   */
  async requireActiveSandbox(): Promise<ActiveOpenSandbox> {
    if (this.pending) return this.pending;
    if (this.activeSandbox) return this.activeSandbox;
    if (this.failure !== undefined) {
      throw new Error(
        `OpenSandbox restore failed: ${getErrorMessage(this.failure)}. `
        + "Run /opensandbox to retry or switch to local execution.",
      );
    }
    throw new Error("OpenSandbox is not active. The tool was not run on the host.");
  }

  /** Returns to local mode, killing owned sandboxes and disconnecting external ones. */
  async deactivate(): Promise<void> {
    const activeSandbox = await this.settlePending();
    if (activeSandbox) await this.release(activeSandbox, activeSandbox.isOwnedByExtension ? "kill" : "disconnect");
    this.failure = undefined;
  }

  /** Releases the session, pausing owned sandboxes so Pi can restore them later. */
  async shutdown(): Promise<void> {
    const activeSandbox = await this.settlePending();
    if (activeSandbox) await this.release(activeSandbox, activeSandbox.isOwnedByExtension ? "pause" : "disconnect");
  }

  private async start(
    sandboxSettings: OpenSandboxSettings,
    restoreTarget?: SandboxRestoreTarget,
  ): Promise<ActiveOpenSandbox> {
    let activeSandbox: ActiveOpenSandbox | undefined;
    try {
      activeSandbox = await this.sandboxStarter(
        sandboxSettings,
        this.hostWorkspaceRoot,
        this.sessionId,
        restoreTarget,
      );
      if (!activeSandbox.isOwnedByExtension) {
        await activeSandbox.renew(sandboxSettings.timeoutSeconds);
      }
      this.stopRenewal = startLeaseRenewal(activeSandbox, sandboxSettings.timeoutSeconds);
      this.activeSandbox = activeSandbox;
      await this.onReady?.(activeSandbox);
      return activeSandbox;
    } catch (error) {
      this.failure = error;
      this.activeSandbox = null;
      await this.stopRenewal?.();
      this.stopRenewal = undefined;
      await activeSandbox?.cleanupAfterStartFailure();
      throw error;
    } finally {
      this.pending = undefined;
    }
  }

  private async settlePending(): Promise<ActiveOpenSandbox | null> {
    if (this.pending) await this.pending.catch(() => undefined);
    return this.activeSandbox;
  }

  private async release(
    activeSandbox: ActiveOpenSandbox,
    mode: "disconnect" | "kill" | "pause",
  ): Promise<void> {
    await activeSandbox.release(mode);
    await this.stopRenewal?.();
    this.stopRenewal = undefined;
    this.activeSandbox = null;
  }
}

function startLeaseRenewal(
  activeSandbox: ActiveOpenSandbox,
  timeoutSeconds: number,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  // Renew halfway through the lease, capped at hourly checks for long leases.
  const timer = setInterval(() => {
    if (pending) return;
    pending = Promise.resolve()
      .then(() => activeSandbox.renew(timeoutSeconds))
      .then(() => undefined)
      .catch((error: unknown) => {
        logOpenSandboxEvent("error", "sandbox.renew.error", {
          sandboxId: activeSandbox.id,
          ...describeOpenSandboxError(error),
        });
      })
      .finally(() => {
        pending = undefined;
      });
  }, Math.min(3_600_000, timeoutSeconds * 500));
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
