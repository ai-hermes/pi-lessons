import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  hasPiOpenSandboxEnvironmentConfig,
  loadInstalledPiOpenSandboxConfig,
  readStoredPiOpenSandboxConfig,
  resolvePiOpenSandboxRuntimeConfig,
  writeStoredPiOpenSandboxConfig,
  type InstalledPiOpenSandboxConfig,
  type PiOpenSandboxOptions,
} from "./config";
import type { ActiveOpenSandbox } from "./sandbox/client";
import type { SandboxSession } from "./sandbox/session";
import type { SkillSyncReport } from "./skills";

/**
 * Session controls used by the installed package's `/opensandbox` command.
 *
 * @example
 * ```ts
 * const runtime: OpenSandboxCommandRuntime = {
 *   session,
 *   activate: () => session.startSandbox(settings),
 * };
 * ```
 */
export interface OpenSandboxCommandRuntime {
  /** Exposes the current local, restoring, remote, or failed mode. */
  session: SandboxSession;
  /** Starts or restores the sandbox attached to the current remote session. */
  activate: () => Promise<ActiveOpenSandbox>;
  /** Returns the latest upload report when Skills are configured and ready. */
  getSkillReport?: () => SkillSyncReport | undefined;
}

export const OPEN_SANDBOX_REMOTE_STATUS = "opensandbox: remote ✓";

/**
 * Registers the interactive `/opensandbox` configuration and mode command.
 *
 * Pass `undefined` as `configPath` for an in-memory extension that only needs
 * session inspection; omit `runtime` when only configuration is available.
 *
 * @example
 * ```ts
 * registerOpenSandboxCommand(pi, "/home/user/.pi/extensions/pi-opensandbox.json");
 * ```
 */
export function registerOpenSandboxCommand(
  pi: ExtensionAPI,
  configPath: string | undefined,
  runtime?: OpenSandboxCommandRuntime,
): void {
  pi.registerCommand("opensandbox", {
    description: "Show or configure OpenSandbox",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const environmentConfigured = hasPiOpenSandboxEnvironmentConfig();
      const stored = configPath === undefined || environmentConfigured
        ? undefined
        : await readStoredPiOpenSandboxConfig(configPath);
      const installed = configPath === undefined
        ? undefined
        : await loadInstalledPiOpenSandboxConfig(process.env, configPath);
      const mode = runtime?.session.getMode() ?? "local";
      const actions = installed?.enabled !== false
        ? [
            ...(mode === "local" ? [
              "Status",
              ...(installed?.enabled === true ? ["Configure"] : []),
            ] : []),
            ...(mode === "remote" ? ["OpenSandbox session running"] : []),
            ...(mode === "remote" && runtime?.getSkillReport?.() !== undefined ? ["Skills"] : []),
            ...(mode === "restoring" ? ["OpenSandbox session starting"] : []),
            ...(mode === "failed" ? ["Retry OpenSandbox", "Status"] : []),
            ...(installed?.enabled === true ? ["Disable"] : []),
          ]
        : ["Enable OpenSandbox"];
      const action = await ctx.ui.select("OpenSandbox", actions);
      if (
        action === "Status"
        || action === "OpenSandbox session running"
        || action === "OpenSandbox session starting"
      ) {
        if (installed === undefined) {
          ctx.ui.notify(describeRuntime(runtime!), "info");
        } else {
          showStatus(ctx, installed, runtime);
        }
        return;
      }
      if (action === "Skills") {
        ctx.ui.notify(describeUploadedSkills(runtime!), "info");
        return;
      }
      if (action === "Retry OpenSandbox") {
        ctx.ui.setStatus("opensandbox", "opensandbox: starting…");
        try {
          const activeSandbox = await runtime!.activate();
          ctx.ui.setStatus("opensandbox", OPEN_SANDBOX_REMOTE_STATUS);
          ctx.ui.notify(
            `OpenSandbox ${activeSandbox.startupMode}: ${activeSandbox.id}`,
            "info",
          );
        } catch (error) {
          ctx.ui.setStatus("opensandbox", "opensandbox: failed");
          ctx.ui.notify(`OpenSandbox failed to start: ${getErrorMessage(error)}`, "error");
        }
        return;
      }
      if (action === "Disable") {
        if (environmentConfigured) {
          ctx.ui.notify(
            "Unset PI_OPENSANDBOX_CONFIG or PI_OPENSANDBOX_CONFIG_FILE to disable OpenSandbox.",
            "error",
          );
          return;
        }
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        await writeStoredPiOpenSandboxConfig({
          enabled: false,
          ...(stored?.options === undefined ? {} : { options: stored.options }),
        }, configPath!);
        ctx.ui.notify("OpenSandbox disabled. Reloading extensions.", "info");
        await ctx.reload();
        return;
      }
      if (action === "Enable OpenSandbox" && stored?.options !== undefined) {
        await writeStoredPiOpenSandboxConfig({
          enabled: true,
          options: stored.options,
        }, configPath!);
        ctx.ui.notify("OpenSandbox enabled. Reloading extensions.", "info");
        await ctx.reload();
        return;
      }
      if (action !== "Configure" && action !== "Enable OpenSandbox") return;
      if (runtime !== undefined && runtime.session.getMode() !== "local") {
        ctx.ui.notify("Configure OpenSandbox from a local Pi session.", "error");
        return;
      }
      if (environmentConfigured) {
        ctx.ui.notify(
          "Unset PI_OPENSANDBOX_CONFIG or PI_OPENSANDBOX_CONFIG_FILE before saving user configuration.",
          "error",
        );
        return;
      }

      const current = stored?.options;
      const sandboxConfig = current?.sandboxConfig ?? {};
      const domain = await promptRequired(
        ctx,
        "OpenSandbox domain",
        stringValue(sandboxConfig.domain),
      );
      if (domain === undefined) return;
      const image = await promptRequired(
        ctx,
        "OpenSandbox image",
        stringValue(sandboxConfig.image),
      );
      if (image === undefined) return;

      const existingKey = stringValue(sandboxConfig.apiKey);
      const environmentKey = process.env.OPENSANDBOX_API_KEY
        ?? process.env.OPEN_SANDBOX_API_KEY;
      let apiKey: string | undefined;
      if (ctx.mode === "tui") {
        apiKey = await ctx.ui.input(
          "OpenSandbox API key",
          existingKey === undefined ? undefined : "leave blank to keep current key",
        );
        if (apiKey === undefined) return;
        if (apiKey === "") apiKey = existingKey;
      } else {
        apiKey = environmentKey;
        if (apiKey === undefined) {
          ctx.ui.notify(
            "Set OPENSANDBOX_API_KEY before configuring OpenSandbox outside TUI mode.",
            "error",
          );
          return;
        }
      }

      const options: PiOpenSandboxOptions = {
        ...current,
        sandboxConfig: {
          ...sandboxConfig,
          domain,
          image,
          ...(apiKey === undefined ? {} : { apiKey }),
        },
      };
      try {
        resolvePiOpenSandboxRuntimeConfig(options, process.env);
      } catch (error) {
        ctx.ui.notify(`Invalid OpenSandbox configuration: ${getErrorMessage(error)}`, "error");
        return;
      }
      await writeStoredPiOpenSandboxConfig({ enabled: true, options }, configPath!);
      ctx.ui.notify(
        "OpenSandbox configured. Restart Pi with --opensandbox to use it.",
        "info",
      );
      await ctx.reload();
    },
  });
}

function showStatus(
  ctx: ExtensionCommandContext,
  config: InstalledPiOpenSandboxConfig,
  runtime?: OpenSandboxCommandRuntime,
): void {
  const sandboxConfig = config.runtime?.sandboxSettings ?? config.options?.sandboxConfig;
  const activeSandbox = runtime?.session.getActiveSandbox();
  const failure = runtime?.session.getFailure();
  ctx.ui.notify([
    `Enabled: ${config.enabled ? "yes" : "no"}`,
    `Source: ${config.source === "environment" ? "environment variables" : config.source === "user" ? "user configuration" : "none"}`,
    `Domain: ${stringValue(sandboxConfig?.domain) ?? "not configured"}`,
    `Image: ${stringValue(sandboxConfig?.image) ?? "not configured"}`,
    `Mode: ${runtime?.session.getMode() ?? "local"}`,
    `Current sandbox: ${activeSandbox?.id ?? "not active"}`,
    describeSkillSync(runtime),
    ...(activeSandbox == null
      ? []
      : [
          `Workspace: ${activeSandbox.sandboxWorkspaceRoot}`,
          `Running image: ${activeSandbox.imageReference}`,
        ]),
    ...(failure === undefined ? [] : [`Error: ${getErrorMessage(failure)}`]),
  ].join("\n"), "info");
}

export function describeSkillSync(runtime?: OpenSandboxCommandRuntime): string {
  if (runtime?.getSkillReport === undefined) return "Skills: not configured";
  const report = runtime.getSkillReport();
  if (report === undefined) return "Skills: pending";
  return `Skills: uploaded (${report.skills.length} ${report.skills.length === 1 ? "skill" : "skills"}, ${report.files} files, ${report.bytes} bytes)`;
}

export function describeUploadedSkills(runtime: OpenSandboxCommandRuntime): string {
  const report = runtime.getSkillReport?.();
  if (!report) return "OpenSandbox Skills are not ready.";
  const skills = report.skills.map(
    (skill) => `${skill.name} ${skill.digest.slice(0, 12)} ${skill.skillFile}`,
  );
  return [`${report.files} files, ${report.bytes} bytes`, ...skills].join("\n");
}

function describeRuntime(runtime: OpenSandboxCommandRuntime): string {
  const activeSandbox = runtime.session.getActiveSandbox();
  return [
    `Mode: ${runtime.session.getMode()}`,
    `Current sandbox: ${activeSandbox?.id ?? "not active"}`,
    describeSkillSync(runtime),
  ].join("\n");
}

async function promptRequired(
  ctx: ExtensionCommandContext,
  title: string,
  current?: string,
): Promise<string | undefined> {
  const value = await ctx.ui.input(title, current);
  if (value === undefined) return undefined;
  const normalized = value.trim() || current;
  if (normalized !== undefined) return normalized;
  ctx.ui.notify(`${title} is required.`, "error");
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
