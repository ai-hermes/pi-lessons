import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiOpenSandboxExtensionFromConfig,
} from "./extension.ts";
import {
  getPiOpenSandboxUserConfigPath,
  loadInstalledPiOpenSandboxConfig,
} from "./config.ts";
import { registerOpenSandboxCommand } from "./config-command.ts";

/**
 * Pi package entry point.
 * Configure it with /opensandbox or the legacy environment variables.
 */
export default async function piOpenSandbox(pi: ExtensionAPI): Promise<void> {
  const configPath = getPiOpenSandboxUserConfigPath();
  const config = await loadInstalledPiOpenSandboxConfig(process.env, configPath);
  if (config.runtime !== undefined) {
    await createPiOpenSandboxExtensionFromConfig(config.runtime, configPath)(pi);
  } else {
    registerOpenSandboxCommand(pi, configPath);
  }
}

export {
  createPiOpenSandboxExtension,
} from "./extension.ts";
export {
  type InstalledPiOpenSandboxConfig,
  type PiOpenSandboxOptions,
  type PiOpenSandboxRuntimeConfig,
} from "./config.ts";
export {
  type SelectedSkill,
  type SkillSyncLimits,
  type SkillSyncReport,
} from "./skills.ts";
