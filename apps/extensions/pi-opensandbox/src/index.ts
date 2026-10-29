import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiOpenSandboxExtensionFromConfig,
} from "./extension.ts";
import { loadPiOpenSandboxConfig } from "./config.ts";

/**
 * Pi package entry point.
 * Configure it with PI_OPENSANDBOX_CONFIG(JSON) or PI_OPENSANDBOX_CONFIG_FILE (path to JSON).
 */
export default async function piOpenSandbox(pi: ExtensionAPI): Promise<void> {
  const config = await loadPiOpenSandboxConfig();
  const extension = createPiOpenSandboxExtensionFromConfig(config);
  await extension(pi);
}

export {
  createPiOpenSandboxExtension,
} from "./extension.ts";
export { type PiOpenSandboxOptions } from "./config.ts";
export {
  type SelectedSkill,
  type SkillSyncLimits,
  type SkillSyncReport,
} from "./skills.ts";
