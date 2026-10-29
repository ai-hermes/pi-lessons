import type { Volume } from "@alibaba-group/opensandbox";
import { normalize as normalizePosix } from "node:path/posix";
import { z } from "zod";

export type OpenSandboxShutdownAction = "keep" | "pause" | "kill";

export interface OpenSandboxLifecyclePolicy {
  onSessionShutdown: OpenSandboxShutdownAction;
}

const nonEmptyString = z.string().trim().min(1, "must be a non-empty string");
const environmentValue = (environment: NodeJS.ProcessEnv, name: string) =>
  environment[name]?.trim()
  || environment[name.replace("OPENSANDBOX", "OPEN_SANDBOX")]?.trim();
const positiveIntegerSchema = (fallback: number, maximum = Number.MAX_SAFE_INTEGER) =>
  z.number().int().positive().max(maximum).default(fallback);
const stringArray = (maximum: number) =>
  z.array(nonEmptyString).max(maximum).transform((values) => [...new Set(values)]);
const stringRecord = z.record(z.string().min(1), z.string()).superRefine((value, ctx) => {
  if (Object.keys(value).length > 64) {
    ctx.addIssue({ code: "custom", message: "must contain at most 64 string values" });
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("opensandbox.io/")) {
      ctx.addIssue({
        code: "custom",
        message: "must not use reserved opensandbox.io/ keys",
        path: [key],
      });
    }
  }
});
const sandboxPath = nonEmptyString.transform((value, ctx) => {
  try {
    return normalizeAbsolutePath(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: getErrorMessage(error) });
    return z.NEVER;
  }
});
const resourceRoot = nonEmptyString.superRefine((value, ctx) => {
  try {
    if (normalizeAbsolutePath(value) !== value || value === "/") {
      ctx.addIssue({
        code: "custom",
        message: "must be a normalized non-root absolute path",
      });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: getErrorMessage(error) });
  }
});
const lifecycleSchema = z.object({
  onSessionShutdown: z.enum(["keep", "pause", "kill"]).default("kill"),
}).default({ onSessionShutdown: "kill" });
const networkPolicySchema = z.object({
  defaultAction: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.enum(["allow", "deny"]).optional(),
  ),
  egress: z.array(z.object({
    action: z.enum(["allow", "deny"]),
    target: nonEmptyString,
  })).max(64).optional(),
}).transform(({ defaultAction, egress }) => ({
  ...(defaultAction === undefined ? {} : { defaultAction }),
  ...(egress === undefined ? {} : { egress }),
}));
const pvcSchema = z.object({
  claimName: nonEmptyString,
  createIfNotExists: z.boolean().optional(),
  deleteOnSandboxTermination: z.boolean().optional(),
  storageClass: nonEmptyString.nullable().optional(),
  storage: nonEmptyString.nullable().optional(),
  accessModes: stringArray(8).nullable().optional(),
}).transform(({
  claimName,
  createIfNotExists,
  deleteOnSandboxTermination,
  storageClass,
  storage,
  accessModes,
}): NonNullable<Volume["pvc"]> => ({
  claimName,
  ...(createIfNotExists === undefined ? {} : { createIfNotExists }),
  ...(deleteOnSandboxTermination === undefined ? {} : { deleteOnSandboxTermination }),
  ...(storageClass === undefined ? {} : { storageClass }),
  ...(storage === undefined ? {} : { storage }),
  ...(accessModes === undefined ? {} : { accessModes }),
}));
const ossfsSchema = z.object({
  bucket: nonEmptyString,
  endpoint: nonEmptyString,
  version: z.enum(["1.0", "2.0"]).optional(),
  options: stringArray(8).nullable().optional(),
  accessKeyId: nonEmptyString,
  accessKeySecret: nonEmptyString,
}).transform(({
  bucket,
  endpoint,
  version,
  options,
  accessKeyId,
  accessKeySecret,
}): NonNullable<Volume["ossfs"]> => ({
  bucket,
  endpoint,
  accessKeyId,
  accessKeySecret,
  ...(version === undefined ? {} : { version }),
  ...(options == null ? {} : { options }),
}));
const volumeSchema = z.object({
  name: nonEmptyString,
  mountPath: sandboxPath,
  pvc: pvcSchema.optional(),
  ossfs: ossfsSchema.optional(),
  readOnly: z.boolean().optional(),
  subPath: nonEmptyString.optional(),
}).superRefine((volume, ctx) => {
  if ((volume.pvc === undefined) === (volume.ossfs === undefined)) {
    ctx.addIssue({ code: "custom", message: "must specify exactly one backend" });
  }
}).transform(({ ossfs, pvc, readOnly, subPath, ...volume }): Volume => ({
  ...volume,
  ...(pvc === undefined ? {} : { pvc }),
  ...(ossfs === undefined ? {} : { ossfs }),
  ...(readOnly === undefined ? {} : { readOnly }),
  ...(subPath === undefined ? {} : { subPath }),
}));
const volumesSchema = z.array(volumeSchema).max(8).superRefine((volumes, ctx) => {
  const names = new Set<string>();
  const mountPaths = new Set<string>();
  volumes.forEach((volume, index) => {
    if (names.has(volume.name)) {
      ctx.addIssue({ code: "custom", message: "volume names must be unique", path: [index, "name"] });
    }
    if (mountPaths.has(volume.mountPath)) {
      ctx.addIssue({ code: "custom", message: "volume mount paths must be unique", path: [index, "mountPath"] });
    }
    names.add(volume.name);
    mountPaths.add(volume.mountPath);
  });
});

const settingsSchema = (environment: NodeJS.ProcessEnv) => z.object({
  apiKey: nonEmptyString.optional(),
  commandTimeoutSeconds: positiveIntegerSchema(120),
  domain: z.preprocess(
    (value) => value ?? environmentValue(environment, "OPENSANDBOX_DOMAIN"),
    nonEmptyString,
  ),
  entrypoint: stringArray(64).transform((value) => value.length === 0 ? undefined : value).optional(),
  env: stringRecord.optional(),
  image: nonEmptyString.optional(),
  lifecycle: lifecycleSchema,
  maxReadBytes: positiveIntegerSchema(1024 * 1024),
  metadata: stringRecord.optional(),
  networkAllowlist: stringArray(32).default([]),
  networkPolicy: networkPolicySchema.optional(),
  protocol: z.enum(["http", "https"]).default("http"),
  readyTimeoutSeconds: positiveIntegerSchema(30),
  requestTimeoutSeconds: positiveIntegerSchema(120),
  resourceRoots: z.array(resourceRoot).max(16).default([]),
  resource: stringRecord.optional(),
  resourceRequests: stringRecord.optional(),
  sandboxId: nonEmptyString.optional(),
  snapshotId: nonEmptyString.optional(),
  timeoutSeconds: positiveIntegerSchema(3600),
  useServerProxy: z.boolean().default(true),
  volumes: volumesSchema.optional(),
  workspace: sandboxPath.default("/workspace"),
}).superRefine((config, ctx) => {
  if (config.sandboxId && (config.image || config.snapshotId || config.volumes)) {
    ctx.addIssue({
      code: "custom",
      message: "OpenSandbox connect configuration must not include image, snapshotId, or volumes",
    });
  }
  if (!config.sandboxId && (config.image === undefined) === (config.snapshotId === undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "OpenSandbox create configuration must include exactly one of image or snapshotId",
    });
  }
  try {
    normalizeEndpoint(config.domain, config.protocol);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: getErrorMessage(error), path: ["domain"] });
  }
}).transform(({ entrypoint, ...config }) => {
  const endpoint = normalizeEndpoint(config.domain, config.protocol);
  const apiKey = config.apiKey ?? environmentValue(environment, "OPENSANDBOX_API_KEY");
  return {
    ...config,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(entrypoint === undefined ? {} : { entrypoint }),
    domain: endpoint.domain,
    protocol: endpoint.protocol,
  };
});

export type OpenSandboxSettings = z.output<ReturnType<typeof settingsSchema>>;

export function resolveOpenSandboxSettings(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): OpenSandboxSettings {
  return settingsSchema(environment).parse(value);
}

function normalizeEndpoint(value: string, fallbackProtocol: "http" | "https"): {
  domain: string;
  protocol: "http" | "https";
} {
  const url = new URL(value.includes("://") ? value : `${fallbackProtocol}://${value}`);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || !url.host
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("domain must be an http or https host with an optional path prefix");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return {
    domain: `${url.host}${path === "/" ? "" : path}`,
    protocol: url.protocol.slice(0, -1) as "http" | "https",
  };
}

function normalizeAbsolutePath(value: string): string {
  const path = value.replace(/\\/g, "/");
  if (!path.startsWith("/") || path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("OpenSandbox paths must be absolute POSIX paths without . or .. segments");
  }
  const normalized = normalizePosix(path);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
