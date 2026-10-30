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
} from "./skills.ts";
import {
  resolveOpenSandboxSettings,
  type OpenSandboxSettings,
} from "./sandbox/config.ts";

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

export type PiOpenSandboxOptions = z.input<typeof optionsSchema>;

export interface PiOpenSandboxRuntimeConfig {
  sandboxSettings: OpenSandboxSettings;
  selectedSkills: SelectedSkill[];
  sharedSkillRoot?: string;
  skillSyncLimits: Required<SkillSyncLimits>;
  verifyUploadedSkills: boolean;
}

export interface InstalledPiOpenSandboxConfig {
  enabled: boolean;
  options?: PiOpenSandboxOptions;
  runtime?: PiOpenSandboxRuntimeConfig;
  source: "environment" | "user" | "none";
}

export function getPiOpenSandboxUserConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "extensions", USER_CONFIG_NAME);
}

export function hasPiOpenSandboxEnvironmentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(environment[CONFIG_ENV] || environment[CONFIG_FILE_ENV]);
}

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
