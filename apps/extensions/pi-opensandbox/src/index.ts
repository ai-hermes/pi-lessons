import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiOpenSandboxExtensionFromConfig,
} from "./extension";
import {
  getPiOpenSandboxUserConfigPath,
  loadInstalledPiOpenSandboxConfig,
} from "./config";
import { registerOpenSandboxCommand } from "./config-command";

export { createPiOpenSandboxExtension } from "./extension";
export type {
  InstalledPiOpenSandboxConfig,
  PiOpenSandboxOptions,
  PiOpenSandboxRuntimeConfig,
} from "./config";
export type {
  SelectedSkill,
  SkillSyncLimits,
  SkillSyncReport,
} from "./skills";

/**
 * Loads persisted configuration and registers the installed Pi extension.
 *
 * When no valid runtime configuration exists, only `/opensandbox` is
 * registered so the user can configure the extension interactively.
 *
 * @example
 * ```ts
 * // Pi invokes the package entry point with its ExtensionAPI instance.
 * await piOpenSandbox(pi);
 * ```
 */
export default async function piOpenSandbox(pi: ExtensionAPI): Promise<void> {
  const configPath = getPiOpenSandboxUserConfigPath();
  const config = await loadInstalledPiOpenSandboxConfig(process.env, configPath);
  if (config.runtime !== undefined) {
    await createPiOpenSandboxExtensionFromConfig(config.runtime, configPath)(pi);
  } else {
    pi.registerFlag("opensandbox", {
      description: "Start this Pi process in OpenSandbox",
      type: "boolean",
    });
    pi.on("session_start", (_event, ctx) => {
      if (!pi.getFlag("opensandbox")) return;
      ctx.ui.setStatus("opensandbox", "opensandbox: failed");
      ctx.ui.notify(
        `OpenSandbox is not enabled or configured at ${configPath}.`,
        "error",
      );
    });
    registerOpenSandboxCommand(pi, configPath);
  }
}
