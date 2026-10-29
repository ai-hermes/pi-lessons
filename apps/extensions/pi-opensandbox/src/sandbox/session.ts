import type { OpenSandboxLifecyclePolicy, OpenSandboxSettings } from "./config.ts";
import { describeOpenSandboxError, logOpenSandboxEvent } from "./logger.ts";
import { ActiveOpenSandbox } from "./client.ts";

type SandboxStarter = (
  sandboxSettings: OpenSandboxSettings,
  hostWorkspaceRoot: string,
  sessionId: string,
) => Promise<ActiveOpenSandbox>;

interface SandboxSessionOptions {
  hostWorkspaceRoot: string;
  onReady?: (activeSandbox: ActiveOpenSandbox) => void | Promise<void>;
  policy: OpenSandboxLifecyclePolicy;
  startSandbox?: SandboxStarter;
}

export class SandboxSession {
  private activeSandbox: ActiveOpenSandbox | null = null;
  private readonly onReady: SandboxSessionOptions["onReady"];
  private readonly policy: OpenSandboxLifecyclePolicy;
  private readonly sandboxStarter: SandboxStarter;
  private hostWorkspaceRoot: string;
  private sessionId = "";
  private stopRenewal: (() => Promise<void>) | undefined;

  constructor(options: SandboxSessionOptions) {
    this.hostWorkspaceRoot = options.hostWorkspaceRoot;
    this.onReady = options.onReady;
    this.policy = options.policy;
    this.sandboxStarter = options.startSandbox ?? ActiveOpenSandbox.start;
  }

  getActiveSandbox(): ActiveOpenSandbox | null {
    return this.activeSandbox;
  }

  getHostWorkspaceRoot(): string {
    return this.hostWorkspaceRoot;
  }

  setSessionContext(sessionId: string, hostWorkspaceRoot: string): void {
    this.sessionId = sessionId;
    this.hostWorkspaceRoot = hostWorkspaceRoot;
  }

  async startSandbox(sandboxSettings: OpenSandboxSettings): Promise<ActiveOpenSandbox> {
    if (this.activeSandbox) {
      throw new Error(`OpenSandbox ${this.activeSandbox.id} is already running`);
    }
    const activeSandbox = await this.sandboxStarter(
      sandboxSettings,
      this.hostWorkspaceRoot,
      this.sessionId,
    );
    try {
      if (!activeSandbox.isOwnedByExtension) {
        await activeSandbox.renew(sandboxSettings.timeoutSeconds);
      }
      this.stopRenewal = startLeaseRenewal(activeSandbox, sandboxSettings.timeoutSeconds);
      this.activeSandbox = activeSandbox;
      await this.onReady?.(activeSandbox);
      return activeSandbox;
    } catch (error) {
      this.activeSandbox = null;
      await this.stopRenewal?.();
      this.stopRenewal = undefined;
      await activeSandbox.cleanupAfterStartFailure();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    const activeSandbox = this.activeSandbox;
    if (!activeSandbox) {
      await this.stopRenewal?.();
      this.stopRenewal = undefined;
      return;
    }
    const releaseMode = activeSandbox.isOwnedByExtension
      ? this.policy.onSessionShutdown === "keep" ? "disconnect" : this.policy.onSessionShutdown
      : "disconnect";
    await activeSandbox.release(releaseMode);
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
