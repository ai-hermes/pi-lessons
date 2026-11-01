import type { OpenSandboxSettings } from "./config";
import { describeOpenSandboxError, logOpenSandboxEvent } from "./logger";
import { getErrorMessage } from "../utils";
import {
  OpenSandboxHandle,
  startOpenSandbox,
  type SandboxRestoreTarget,
} from "./client";

interface SandboxSessionOptions {
  /** Host directory represented by the sandbox workspace. */
  hostWorkspaceRoot: string;
  /** Performs extension-specific setup after the sandbox becomes reachable. */
  initializeSandbox?: (sandboxHandle: OpenSandboxHandle) => void | Promise<void>;
  /** Startup seam used by tests; production callers use the default implementation. */
  startOpenSandbox?: typeof startOpenSandbox;
}

/**
 * Observable lifecycle state for one Pi session's remote sandbox.
 *
 * `inactive` has no live connection, while `failed` preserves the latest
 * startup error so tools and status views can explain why remote execution is
 * unavailable.
 */
export type SandboxSessionState = "inactive" | "starting" | "active" | "failed";

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
 * session.setPiSessionContext("pi-session-123", process.cwd());
 * const sandboxHandle = await session.ensureActiveSandboxHandle(settings);
 * await session.releaseForShutdown();
 * ```
 */
export class SandboxSession {
  private activeSandboxHandle: OpenSandboxHandle | null = null;
  private startupFailure: Error | undefined;
  private readonly initializeSandbox: SandboxSessionOptions["initializeSandbox"];
  private readonly startOpenSandbox: typeof startOpenSandbox;
  private startupPromise: Promise<OpenSandboxHandle> | undefined;
  private hostWorkspaceRoot: string;
  private piSessionId = "";
  private stopLeaseRenewal: (() => Promise<void>) | undefined;

  constructor(options: SandboxSessionOptions) {
    this.hostWorkspaceRoot = options.hostWorkspaceRoot;
    this.initializeSandbox = options.initializeSandbox;
    this.startOpenSandbox = options.startOpenSandbox ?? startOpenSandbox;
  }

  /** Returns the live sandbox after startup and initialization complete. */
  getActiveSandboxHandle(): OpenSandboxHandle | null {
    return this.activeSandboxHandle;
  }

  /** Returns the host workspace currently associated with the Pi session. */
  getHostWorkspaceRoot(): string {
    return this.hostWorkspaceRoot;
  }

  /**
   * Derives the lifecycle state from the current startup, connection, and error state.
   *
   * @example
   * ```ts
   * if (session.getLifecycleState() === "active") {
   *   ctx.ui.setStatus("opensandbox", "opensandbox: remote ✓");
   * }
   * ```
   */
  getLifecycleState(): SandboxSessionState {
    if (this.startupPromise) return "starting";
    if (this.activeSandboxHandle) return "active";
    return this.startupFailure === undefined ? "inactive" : "failed";
  }

  /** Returns the most recent startup or restoration error, if any. */
  getStartupFailure(): Error | undefined {
    return this.startupFailure;
  }

  /** Clears the startup error only when no startup or connection is active. */
  clearStartupFailure(): void {
    if (!this.startupPromise && !this.activeSandboxHandle) this.startupFailure = undefined;
  }

  /**
   * Updates identifiers that may change when Pi opens or navigates to another session.
   *
   * @example
   * ```ts
   * session.setPiSessionContext(
   *   ctx.sessionManager.getSessionId(),
   *   ctx.sessionManager.getCwd(),
   * );
   * ```
   */
  setPiSessionContext(piSessionId: string, hostWorkspaceRoot: string): void {
    this.piSessionId = piSessionId;
    this.hostWorkspaceRoot = hostWorkspaceRoot;
  }

  /**
   * Starts, reconnects, or resumes a sandbox.
   *
   * Repeated calls return the active sandbox, and concurrent calls await the
   * same in-flight startup rather than creating duplicate sandboxes.
   *
   * @example
   * ```ts
   * const sandboxHandle = await session.ensureActiveSandboxHandle(settings, {
   *   sandboxId: persistedState.sandboxId,
   *   owned: persistedState.owned,
   * });
   * ```
   */
  ensureActiveSandboxHandle(
    sandboxSettings: OpenSandboxSettings,
    restoreTarget?: SandboxRestoreTarget,
  ): Promise<OpenSandboxHandle> {
    if (this.startupPromise) return this.startupPromise;
    if (this.activeSandboxHandle) return Promise.resolve(this.activeSandboxHandle);
    this.startupFailure = undefined;
    const startupPromise = this.startAndInitializeSandbox(sandboxSettings, restoreTarget);
    this.startupPromise = startupPromise;
    void startupPromise.catch(() => undefined);
    return startupPromise;
  }

  /**
   * Waits for startup when necessary and returns the active sandbox.
   *
   * Throws instead of falling back to host execution, preventing a remote-mode
   * tool call from accidentally running against local files.
   *
   * @example
   * ```ts
   * registerOpenSandboxTools(
   *   pi,
   *   () => session.requireActiveSandboxHandle(),
   *   () => session.getHostWorkspaceRoot(),
   * );
   * ```
   */
  async requireActiveSandboxHandle(): Promise<OpenSandboxHandle> {
    if (this.startupPromise) return this.startupPromise;
    if (this.activeSandboxHandle) return this.activeSandboxHandle;
    if (this.startupFailure !== undefined) {
      throw new Error(
        `OpenSandbox restore failed: ${this.startupFailure.message}. `
        + "Run /opensandbox to retry or switch to local execution.",
      );
    }
    throw new Error("OpenSandbox is not active. The tool was not run on the host.");
  }

  /**
   * Deactivates remote execution, killing owned sandboxes and disconnecting external ones.
   *
   * @example
   * ```ts
   * await session.releaseForDisable();
   * ```
   */
  async releaseForDisable(): Promise<void> {
    const sandboxHandle = await this.waitForStartup();
    if (sandboxHandle) {
      await this.releaseActiveSandbox(
        sandboxHandle,
        sandboxHandle.isOwnedByExtension ? "kill" : "disconnect",
      );
    }
    this.startupFailure = undefined;
  }

  /**
   * Releases the session, pausing owned sandboxes so Pi can restore them later.
   *
   * @example
   * ```ts
   * pi.on("session_shutdown", () => session.releaseForShutdown());
   * ```
   */
  async releaseForShutdown(): Promise<void> {
    const sandboxHandle = await this.waitForStartup();
    if (sandboxHandle) {
      await this.releaseActiveSandbox(
        sandboxHandle,
        sandboxHandle.isOwnedByExtension ? "pause" : "disconnect",
      );
    }
  }

  private async startAndInitializeSandbox(
    sandboxSettings: OpenSandboxSettings,
    restoreTarget?: SandboxRestoreTarget,
  ): Promise<OpenSandboxHandle> {
    let sandboxHandle: OpenSandboxHandle | undefined;
    try {
      sandboxHandle = await this.startOpenSandbox(
        {
          ...sandboxSettings,
          metadata: {
            ...sandboxSettings.metadata,
            "pi-extension": "opensandbox",
            "pi-session-id": this.piSessionId,
          },
        },
        this.hostWorkspaceRoot,
        restoreTarget,
      );
      if (!sandboxHandle.isOwnedByExtension) {
        await sandboxHandle.renew(sandboxSettings.timeoutSeconds);
      }
      this.startLeaseRenewal(sandboxHandle, sandboxSettings.timeoutSeconds);
      this.activeSandboxHandle = sandboxHandle;
      await this.initializeSandbox?.(sandboxHandle);
      return sandboxHandle;
    } catch (error) {
      const startupFailure = error instanceof Error ? error : new Error(getErrorMessage(error));
      this.startupFailure = startupFailure;
      this.activeSandboxHandle = null;
      await this.stopLeaseRenewal?.();
      this.stopLeaseRenewal = undefined;
      await sandboxHandle?.cleanupAfterStartFailure();
      throw startupFailure;
    } finally {
      this.startupPromise = undefined;
    }
  }

  private async waitForStartup(): Promise<OpenSandboxHandle | null> {
    if (this.startupPromise) await this.startupPromise.catch(() => undefined);
    return this.activeSandboxHandle;
  }

  private async releaseActiveSandbox(
    sandboxHandle: OpenSandboxHandle,
    mode: "disconnect" | "kill" | "pause",
  ): Promise<void> {
    await sandboxHandle.release(mode);
    await this.stopLeaseRenewal?.();
    this.stopLeaseRenewal = undefined;
    this.activeSandboxHandle = null;
  }

  private startLeaseRenewal(
    sandboxHandle: OpenSandboxHandle,
    timeoutSeconds: number,
  ): void {
    let pendingRenewal: Promise<void> | undefined;
    // Renew halfway through the lease, capped at hourly checks for long leases.
    const renewalTimer = setInterval(() => {
      if (pendingRenewal) return;
      pendingRenewal = Promise.resolve()
        .then(() => sandboxHandle.renew(timeoutSeconds))
        .then(() => undefined)
        .catch((error: unknown) => {
          logOpenSandboxEvent("error", "sandbox.renew.error", {
            sandboxId: sandboxHandle.id,
            ...describeOpenSandboxError(error),
          });
        })
        .finally(() => {
          pendingRenewal = undefined;
        });
    }, Math.min(3_600_000, timeoutSeconds * 500));
    renewalTimer.unref();
    this.stopLeaseRenewal = async () => {
      clearInterval(renewalTimer);
      await pendingRenewal;
    };
  }
}
