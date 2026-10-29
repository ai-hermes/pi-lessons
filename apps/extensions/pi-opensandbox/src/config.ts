import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
