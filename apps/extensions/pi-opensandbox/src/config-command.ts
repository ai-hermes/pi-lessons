import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  resolvePiOpenSandboxRuntimeConfig,
  writeStoredPiOpenSandboxConfig,
  type InstalledPiOpenSandboxConfig,
  type PiOpenSandboxOptions,
} from "./config";
import type { ActiveOpenSandbox } from "./sandbox/client";
import type { SandboxSession } from "./sandbox/session";
import type { SkillSyncReport } from "./skills";
import { getErrorMessage } from "./utils";

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
  /** Exposes the current inactive, restoring, active, or failed state. */
  session: SandboxSession;
  /** Starts or restores the sandbox attached to the current remote session. */
  activate: () => Promise<ActiveOpenSandbox>;
  /** Returns the latest upload report when Skills are configured and ready. */
  getSkillReport?: () => SkillSyncReport | undefined;
}

export const OPEN_SANDBOX_REMOTE_STATUS = "opensandbox: remote ✓";

export interface OpenSandboxCommandOptions {
  /** Configuration snapshot loaded when the extension starts. */
  installedConfig?: InstalledPiOpenSandboxConfig;
  /** User configuration file written by interactive configuration actions. */
  userConfigPath?: string;
  /** Active session controls when remote execution is available. */
  runtime?: OpenSandboxCommandRuntime;
}

/**
 * Registers the interactive `/opensandbox` configuration and status command.
 *
 * @example
 * ```ts
 * registerOpenSandboxCommand(pi, {
 *   installedConfig,
 *   userConfigPath: "/home/user/.pi/extensions/pi-opensandbox.json",
 * });
 * ```
 */
export function registerOpenSandboxCommand(
  pi: ExtensionAPI,
  options: OpenSandboxCommandOptions = {},
): void {
  const { installedConfig, userConfigPath, runtime } = options;
  const environmentConfigured = installedConfig?.source === "environment";
  const storedConfig = installedConfig?.source === "user"
    ? installedConfig
    : undefined;

  pi.registerCommand("opensandbox", {
    description: "Show or configure OpenSandbox",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const sessionState = runtime?.session.getState() ?? "inactive";
      const actions = installedConfig?.enabled !== false
        ? [
            ...(sessionState === "inactive" ? [
              "Status",
              ...(installedConfig?.enabled === true ? ["Configure"] : []),
            ] : []),
            ...(sessionState === "active" ? ["OpenSandbox session running"] : []),
            ...(sessionState === "active" && runtime?.getSkillReport?.() !== undefined
              ? ["Skills"]
              : []),
            ...(sessionState === "restoring" ? ["OpenSandbox session starting"] : []),
            ...(sessionState === "failed" ? ["Retry OpenSandbox", "Status"] : []),
            ...(installedConfig?.enabled === true ? ["Disable"] : []),
          ]
        : ["Enable OpenSandbox"];
      const action = await ctx.ui.select("OpenSandbox", actions);
      if (
        action === "Status"
        || action === "OpenSandbox session running"
        || action === "OpenSandbox session starting"
      ) {
        if (installedConfig === undefined) {
          ctx.ui.notify(describeRuntime(runtime!), "info");
        } else {
          showStatus(ctx, installedConfig, runtime);
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
          ...(storedConfig?.options === undefined ? {} : { options: storedConfig.options }),
        }, userConfigPath!);
        ctx.ui.notify("OpenSandbox disabled. Reloading extensions.", "info");
        await ctx.reload();
        return;
      }
      if (action === "Enable OpenSandbox" && storedConfig?.options !== undefined) {
        await writeStoredPiOpenSandboxConfig({
          enabled: true,
          options: storedConfig.options,
        }, userConfigPath!);
        ctx.ui.notify("OpenSandbox enabled. Reloading extensions.", "info");
        await ctx.reload();
        return;
      }
      if (action !== "Configure" && action !== "Enable OpenSandbox") return;
      if (runtime !== undefined && runtime.session.getState() !== "inactive") {
        ctx.ui.notify("Configure OpenSandbox while it is inactive.", "error");
        return;
      }
      if (environmentConfigured) {
        ctx.ui.notify(
          "Unset PI_OPENSANDBOX_CONFIG or PI_OPENSANDBOX_CONFIG_FILE before saving user configuration.",
          "error",
        );
        return;
      }

      const currentOptions = storedConfig?.options;
      const sandboxConfig = currentOptions?.sandboxConfig ?? {};
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

      const updatedOptions: PiOpenSandboxOptions = {
        ...currentOptions,
        sandboxConfig: {
          ...sandboxConfig,
          domain,
          image,
          ...(apiKey === undefined ? {} : { apiKey }),
        },
      };
      try {
        resolvePiOpenSandboxRuntimeConfig(updatedOptions, process.env);
      } catch (error) {
        ctx.ui.notify(`Invalid OpenSandbox configuration: ${getErrorMessage(error)}`, "error");
        return;
      }
      await writeStoredPiOpenSandboxConfig({
        enabled: true,
        options: updatedOptions,
      }, userConfigPath!);
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
    `State: ${runtime?.session.getState() ?? "inactive"}`,
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
  const skillSyncReport = runtime.getSkillReport();
  if (skillSyncReport === undefined) return "Skills: pending";
  return `Skills: uploaded (${skillSyncReport.skills.length} ${skillSyncReport.skills.length === 1 ? "skill" : "skills"}, ${skillSyncReport.files} files, ${skillSyncReport.bytes} bytes)`;
}

export function describeUploadedSkills(runtime: OpenSandboxCommandRuntime): string {
  const skillSyncReport = runtime.getSkillReport?.();
  if (!skillSyncReport) return "OpenSandbox Skills are not ready.";
  const skillLines = skillSyncReport.skills.map(
    (skill) => `${skill.name} ${skill.digest.slice(0, 12)} ${skill.skillFile}`,
  );
  return [
    `${skillSyncReport.files} files, ${skillSyncReport.bytes} bytes`,
    ...skillLines,
  ].join("\n");
}

function describeRuntime(runtime: OpenSandboxCommandRuntime): string {
  const activeSandbox = runtime.session.getActiveSandbox();
  return [
    `State: ${runtime.session.getState()}`,
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
