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
} from "./config.ts";
import type { ActiveOpenSandbox } from "./sandbox/client.ts";

export function registerOpenSandboxCommand(
  pi: ExtensionAPI,
  configPath: string,
  getActiveSandbox: () => ActiveOpenSandbox | null | undefined = () => undefined,
): void {
  pi.registerCommand("opensandbox", {
    description: "Show or configure OpenSandbox",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const stored = await readStoredPiOpenSandboxConfig(configPath);
      const action = await ctx.ui.select("OpenSandbox", [
        "Status",
        "Configure and enable",
        "Disable",
      ]);
      if (action === "Status") {
        showStatus(
          ctx,
          await loadInstalledPiOpenSandboxConfig(process.env, configPath),
          getActiveSandbox(),
        );
        return;
      }
      if (action === "Disable") {
        if (hasPiOpenSandboxEnvironmentConfig()) {
          ctx.ui.notify(
            "Unset PI_OPENSANDBOX_CONFIG or PI_OPENSANDBOX_CONFIG_FILE to disable OpenSandbox.",
            "error",
          );
          return;
        }
        await writeStoredPiOpenSandboxConfig({
          enabled: false,
          ...(stored?.options === undefined ? {} : { options: stored.options }),
        }, configPath);
        ctx.ui.notify("OpenSandbox disabled. Reloading extensions.", "info");
        await ctx.reload();
        return;
      }
      if (action !== "Configure and enable") return;
      if (hasPiOpenSandboxEnvironmentConfig()) {
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
      await writeStoredPiOpenSandboxConfig({ enabled: true, options }, configPath);
      ctx.ui.notify("OpenSandbox configured. Reloading extensions.", "info");
      await ctx.reload();
    },
  });
}

function showStatus(
  ctx: ExtensionCommandContext,
  config: InstalledPiOpenSandboxConfig,
  activeSandbox: ActiveOpenSandbox | null | undefined,
): void {
  const sandboxConfig = config.runtime?.sandboxSettings ?? config.options?.sandboxConfig;
  ctx.ui.notify([
    `Enabled: ${config.enabled ? "yes" : "no"}`,
    `Source: ${config.source === "environment" ? "environment variables" : config.source === "user" ? "user configuration" : "none"}`,
    `Domain: ${stringValue(sandboxConfig?.domain) ?? "not configured"}`,
    `Image: ${stringValue(sandboxConfig?.image) ?? "not configured"}`,
    `API key: ${stringValue(sandboxConfig?.apiKey) ? "configured" : "missing"}`,
    `Current sandbox: ${activeSandbox?.id ?? "not active"}`,
    ...(activeSandbox == null
      ? []
      : [
          `Workspace: ${activeSandbox.sandboxWorkspaceRoot}`,
          `Running image: ${activeSandbox.imageReference}`,
        ]),
  ].join("\n"), "info");
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
