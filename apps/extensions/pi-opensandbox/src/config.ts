import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  parseSharedSkillRoot,
  parseSkillSyncLimits,
  type SelectedSkill,
  type SkillSyncLimits,
} from "./skills";
import {
  resolveOpenSandboxSettings,
  type OpenSandboxSettings,
} from "./sandbox/config";

const CONFIG_ENV = "PI_OPENSANDBOX_CONFIG";
const CONFIG_FILE_ENV = "PI_OPENSANDBOX_CONFIG_FILE";
const USER_CONFIG_NAME = "opensandbox.json";

const nonEmptyStringSchema = z.string().trim().min(1);
const selectedSkillSchema = z.object({
  name: nonEmptyStringSchema.optional(),
  sourceDir: nonEmptyStringSchema,
}).transform(({ name, sourceDir }): SelectedSkill => ({
  sourceDir,
  ...(name === undefined ? {} : { name }),
}));
const skillSyncLimitsSchema = z.object({
  maxFileBytes: z.number().optional(),
  maxTotalBytes: z.number().optional(),
  maxFiles: z.number().optional(),
}).transform(({ maxFileBytes, maxTotalBytes, maxFiles }): SkillSyncLimits => ({
  ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
  ...(maxFiles === undefined ? {} : { maxFiles }),
}));
const optionsSchema = z.object({
  sandboxConfig: z.record(z.string(), z.unknown()),
  skills: z.array(selectedSkillSchema).min(1).optional(),
  sharedSkillRoot: nonEmptyStringSchema.optional(),
  skillSyncLimits: skillSyncLimitsSchema.optional(),
  verifyUploadedSkills: z.boolean().optional(),
}).strict().superRefine((options, ctx) => {
  if ((options.skills !== undefined) !== (options.sharedSkillRoot !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "skills and sharedSkillRoot must be configured together",
    });
  }
});
const resourceRootsSchema = z.array(z.string()).optional();

/**
 * User-facing options accepted by the Pi OpenSandbox extension.
 *
 * `skills` and `sharedSkillRoot` must either both be provided or both be omitted.
 *
 * @example
 * const options: PiOpenSandboxOptions = {
 *   sandboxConfig: {
 *     domain: "https://sandbox.example.com",
 *     image: "opensandbox/code-interpreter:v1",
 *   },
 *   verifyUploadedSkills: true,
 * };
 */
export type PiOpenSandboxOptions = z.input<typeof optionsSchema>;

/**
 * Validated configuration used internally to start and manage a sandbox.
 *
 * @example
 * const runtime = resolvePiOpenSandboxRuntimeConfig({
 *   sandboxConfig: {
 *     domain: "https://sandbox.example.com",
 *     image: "opensandbox/code-interpreter:v1",
 *   },
 * });
 * console.log(runtime.sandboxSettings.image);
 */
export interface PiOpenSandboxRuntimeConfig {
  /** Normalized OpenSandbox connection and lifecycle settings. */
  sandboxSettings: OpenSandboxSettings;
  /** Skills selected for upload to the remote sandbox. */
  selectedSkills: SelectedSkill[];
  /** Sandbox-only root used to expose uploaded Skills. */
  sharedSkillRoot?: string;
  /** Resolved upload limits with defaults applied. */
  skillSyncLimits: Required<SkillSyncLimits>;
  /** Whether uploaded Skill content is verified after transfer. */
  verifyUploadedSkills: boolean;
}

/**
 * Effective configuration discovered from the environment or the user config file.
 *
 * @example
 * const installed = await loadInstalledPiOpenSandboxConfig();
 * if (installed.enabled && installed.runtime) {
 *   console.log(`Loaded OpenSandbox configuration from ${installed.source}`);
 * }
 */
export interface InstalledPiOpenSandboxConfig {
  /** Whether OpenSandbox is configured for use. */
  enabled: boolean;
  /** Persisted user options before environment overrides are applied. */
  options?: PiOpenSandboxOptions;
  /** Validated runtime configuration when OpenSandbox is enabled. */
  runtime?: PiOpenSandboxRuntimeConfig;
  /** Location from which the effective configuration was loaded. */
  source: "environment" | "user" | "none";
}

/**
 * Returns the shared OpenSandbox configuration path used across Pi sessions.
 *
 * @example
 * // Default Pi agent directory:
 * // ~/.pi/agent/extensions/opensandbox.json
 *
 * getPiOpenSandboxUserConfigPath("/tmp/pi-agent");
 * // /tmp/pi-agent/extensions/opensandbox.json
 */
export function getPiOpenSandboxUserConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "extensions", USER_CONFIG_NAME);
}

/**
 * Reports whether either supported environment-based configuration is present.
 *
 * @example
 * hasPiOpenSandboxEnvironmentConfig({
 *   PI_OPENSANDBOX_CONFIG: '{"sandboxConfig":{"image":"example"}}',
 * });
 * // true
 */
export function hasPiOpenSandboxEnvironmentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(environment[CONFIG_ENV] || environment[CONFIG_FILE_ENV]);
}

/**
 * Loads the effective installed configuration.
 *
 * Environment configuration takes precedence over the persisted user file.
 *
 * @example
 * const config = await loadInstalledPiOpenSandboxConfig(
 *   { OPENSANDBOX_API_KEY: "your-api-key" },
 *   "/tmp/pi-agent/extensions/opensandbox.json",
 * );
 * console.log(config.source);
 */
export async function loadInstalledPiOpenSandboxConfig(
  environment: NodeJS.ProcessEnv = process.env,
  configPath = getPiOpenSandboxUserConfigPath(),
): Promise<InstalledPiOpenSandboxConfig> {
  if (hasPiOpenSandboxEnvironmentConfig(environment)) {
    return {
      enabled: true,
      runtime: await loadPiOpenSandboxConfig(environment),
      source: "environment",
    };
  }

  const stored = await readStoredPiOpenSandboxConfig(configPath);
  if (stored === undefined) return { enabled: false, source: "none" };
  if (stored.enabled === false) {
    return {
      enabled: false,
      source: "user",
      ...(stored.options === undefined ? {} : { options: stored.options }),
    };
  }

  const options = stored.options!;
  const environmentApiKey = environment.OPENSANDBOX_API_KEY
    ?? environment.OPEN_SANDBOX_API_KEY;
  const effectiveOptions = environmentApiKey === undefined
    ? options
    : {
      ...options,
      sandboxConfig: { ...options.sandboxConfig, apiKey: environmentApiKey },
    };
  return {
    enabled: true,
    options,
    runtime: resolvePiOpenSandboxRuntimeConfig(effectiveOptions, environment),
    source: "user",
  };
}

/**
 * Reads and validates the persisted user configuration.
 *
 * Returns `undefined` when the file does not exist.
 *
 * @example
 * const stored = await readStoredPiOpenSandboxConfig(
 *   "/tmp/pi-agent/extensions/opensandbox.json",
 * );
 * console.log(stored?.enabled ?? false);
 */
export async function readStoredPiOpenSandboxConfig(
  configPath = getPiOpenSandboxUserConfigPath(),
): Promise<{ enabled: boolean; options?: PiOpenSandboxOptions } | undefined> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new Error("OpenSandbox user configuration is not valid JSON", { cause: error });
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("OpenSandbox user configuration must be an object");
  }

  const { enabled = true, ...optionsInput } = input as Record<string, unknown>;
  if (typeof enabled !== "boolean") {
    throw new Error("OpenSandbox user configuration enabled must be a boolean");
  }
  if (!enabled && Object.keys(optionsInput).length === 0) return { enabled };
  return { enabled, options: optionsSchema.parse(optionsInput) };
}

/**
 * Validates and atomically writes the user configuration with mode `0600`.
 *
 * @example
 * await writeStoredPiOpenSandboxConfig(
 *   {
 *     enabled: true,
 *     options: {
 *       sandboxConfig: {
 *         domain: "https://sandbox.example.com",
 *         image: "opensandbox/code-interpreter:v1",
 *       },
 *     },
 *   },
 *   "/tmp/pi-agent/extensions/opensandbox.json",
 * );
 */
export async function writeStoredPiOpenSandboxConfig(
  value: { enabled: boolean; options?: PiOpenSandboxOptions },
  configPath = getPiOpenSandboxUserConfigPath(),
): Promise<void> {
  if (value.enabled && value.options === undefined) {
    throw new Error("Enabled OpenSandbox configuration requires options");
  }
  if (value.options !== undefined) optionsSchema.parse(value.options);

  const directory = dirname(configPath);
  const temporaryPath = join(directory, `.${USER_CONFIG_NAME}.${randomUUID()}.tmp`);
  const output = JSON.stringify({
    enabled: value.enabled,
    ...value.options,
  }, null, 2) + "\n";
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Loads runtime configuration from inline JSON or a referenced JSON file.
 *
 * Exactly one of `PI_OPENSANDBOX_CONFIG` and `PI_OPENSANDBOX_CONFIG_FILE`
 * must be set.
 *
 * @example
 * const runtime = await loadPiOpenSandboxConfig({
 *   OPENSANDBOX_API_KEY: "your-api-key",
 *   PI_OPENSANDBOX_CONFIG: JSON.stringify({
 *     sandboxConfig: {
 *       domain: "https://sandbox.example.com",
 *       image: "opensandbox/code-interpreter:v1",
 *     },
 *   }),
 * });
 */
export async function loadPiOpenSandboxConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PiOpenSandboxRuntimeConfig> {
  const inlineConfig = environment[CONFIG_ENV];
  const configFile = environment[CONFIG_FILE_ENV];
  if (inlineConfig && configFile) {
    throw new Error(`Set only one of ${CONFIG_ENV} or ${CONFIG_FILE_ENV}`);
  }
  if (!inlineConfig && !configFile) {
    throw new Error(`Configure the extension with ${CONFIG_ENV} or ${CONFIG_FILE_ENV}`);
  }

  const source = inlineConfig ?? await readFile(resolve(configFile!), "utf8");
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new Error("OpenSandbox configuration is not valid JSON", { cause: error });
  }
  return resolvePiOpenSandboxRuntimeConfig(input, environment);
}

/**
 * Validates user input and resolves it into the configuration used at runtime.
 *
 * @example
 * const runtime = resolvePiOpenSandboxRuntimeConfig(
 *   {
 *     sandboxConfig: {
 *       domain: "https://sandbox.example.com",
 *       image: "opensandbox/code-interpreter:v1",
 *     },
 *   },
 *   { OPENSANDBOX_API_KEY: "your-api-key" },
 * );
 * console.log(runtime.verifyUploadedSkills);
 * // true
 */
export function resolvePiOpenSandboxRuntimeConfig(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): PiOpenSandboxRuntimeConfig {
  const parsed = optionsSchema.parse(input);
  const selectedSkills = parsed.skills ?? [];
  const sharedSkillRoot = parsed.sharedSkillRoot === undefined
    ? undefined
    : parseSharedSkillRoot(parsed.sharedSkillRoot);
  const skillSyncLimits = parseSkillSyncLimits(parsed.skillSyncLimits);
  const sandboxConfig = sharedSkillRoot === undefined
    ? parsed.sandboxConfig
    : addSharedRoot(parsed.sandboxConfig, sharedSkillRoot);
  const sandboxSettings = resolveOpenSandboxSettings(sandboxConfig, environment);

  return {
    sandboxSettings,
    selectedSkills,
    skillSyncLimits,
    verifyUploadedSkills: parsed.verifyUploadedSkills !== false,
    ...(sharedSkillRoot === undefined ? {} : { sharedSkillRoot }),
  };
}

function addSharedRoot(config: Record<string, unknown>, root: string): Record<string, unknown> {
  const current = resourceRootsSchema.parse(config.resourceRoots) ?? [];
  return {
    ...config,
    resourceRoots: [...new Set([...current, root])],
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
