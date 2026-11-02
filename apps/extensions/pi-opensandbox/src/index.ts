import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiOpenSandboxExtensionFromConfig,
} from "./extension";
import {
  loadInstalledPiOpenSandboxConfig,
  resolveUserConfigPath,
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
  const userConfigPath = resolveUserConfigPath();
  const installedConfig = await loadInstalledPiOpenSandboxConfig(process.env, userConfigPath);
  if (installedConfig.runtime !== undefined) {
    await createPiOpenSandboxExtensionFromConfig(
      installedConfig.runtime,
      { installedConfig, userConfigPath },
    )(pi);
  } else {
    pi.registerFlag("opensandbox", {
      description: "Start this Pi process in OpenSandbox",
      type: "boolean",
    });
    pi.on("session_start", (_event, ctx) => {
      if (!pi.getFlag("opensandbox")) return;
      ctx.ui.setStatus("opensandbox", "opensandbox: failed");
      ctx.ui.notify(
        `OpenSandbox is not enabled or configured at ${userConfigPath}.`,
        "error",
      );
    });
    registerOpenSandboxCommand(pi, { installedConfig, userConfigPath });
  }
}
