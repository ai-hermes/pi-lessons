import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionContext,
  ExtensionFactory,
  Skill,
} from "@earendil-works/pi-coding-agent";
import {
  createSyntheticSourceInfo,
  getAgentDir,
  loadSkillsFromDir,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
  materializeSkills,
  uploadSkills,
  type MaterializedSkill,
  type SkillSyncReport,
} from "./skills";
import {
  resolvePiOpenSandboxRuntimeConfig,
  type PiOpenSandboxOptions,
  type PiOpenSandboxRuntimeConfig,
} from "./config";
import {
  OPEN_SANDBOX_REMOTE_STATUS,
  registerOpenSandboxCommand,
  type OpenSandboxCommandOptions,
  type OpenSandboxRuntime,
} from "./config-command";
import { describeOpenSandboxError, logOpenSandboxEvent } from "./sandbox/logger";
import { SandboxSession } from "./sandbox/session";
import { registerOpenSandboxTools } from "./sandbox/tools";
import { dirnamePosix, escapeXml, getErrorMessage } from "./utils";

export type { PiOpenSandboxOptions } from "./config";

const STATE_ENTRY_TYPE = "pi-opensandbox-state";

/**
 * Remote-execution state persisted in Pi custom session entries.
 *
 * The latest entry on the active branch determines whether a resumed session
 * should reconnect to a sandbox and whether that sandbox is extension-owned.
 *
 * @example
 * ```ts
 * const state: PersistedSandboxState = {
 *   active: true,
 *   sandboxId: "sandbox-123",
 *   owned: true,
 * };
 * ```
 */
export type PersistedSandboxState =
  | {
      /** The Pi session uses local execution. */
      active: false;
      sandboxId?: never;
      owned?: never;
    }
  | {
      /** The Pi session expects subsequent tools to run remotely. */
      active: true;
      /** Sandbox to resume; absent while a new remote session starts. */
      sandboxId?: string;
      /** Whether this extension created and manages the sandbox. */
      owned?: boolean;
    };

/**
 * Creates a Pi extension factory from user-facing OpenSandbox options.
 *
 * @example
 * ```ts
 * const extension = createPiOpenSandboxExtension({
 *   sandboxConfig: {
 *     domain: "sandbox.example.com",
 *     image: "node:22",
 *   },
 * });
 * ```
 */
export function createPiOpenSandboxExtension(
  options: PiOpenSandboxOptions,
): ExtensionFactory {
  return createPiOpenSandboxExtensionFromConfig(
    resolvePiOpenSandboxRuntimeConfig(options),
  );
}

/**
 * Creates a Pi extension factory from an already validated runtime config.
 *
 * Use {@link createPiOpenSandboxExtension} unless configuration has already
 * been resolved by the installed-package loader.
 *
 * @example
 * ```ts
 * const runtime = resolvePiOpenSandboxRuntimeConfig({
 *   sandboxConfig: {
 *     domain: "sandbox.example.com",
 *     image: "node:22",
 *   },
 * });
 * const extension = createPiOpenSandboxExtensionFromConfig(runtime);
 * ```
 */
export function createPiOpenSandboxExtensionFromConfig(
  config: PiOpenSandboxRuntimeConfig,
  commandOptions: Omit<OpenSandboxCommandOptions, "runtime"> = {},
): ExtensionFactory {
  const {
    sandboxSettings,
    selectedSkills,
    sharedSkillRoot,
    skillSyncLimits,
    verifyUploadedSkills,
  } = config;
  return async (pi) => {
    pi.registerFlag("opensandbox", {
      description: "Start this Pi process in OpenSandbox",
      type: "boolean",
    });
    const localSkillRoot = join(getAgentDir(), "cache", "pi-opensandbox", "skills");
    let materializedSkills: MaterializedSkill[] = [];
    let selectedSkillDefinitions: Skill[] = [];
    let skillPreparation: Promise<void> | undefined;
    let skillSyncReport: SkillSyncReport | undefined;
    let persistedSandboxState: PersistedSandboxState = {
      active: false
    };
    let remoteToolsRegistered = false;
    const ensureSelectedSkills = async () => {
      if (sharedSkillRoot === undefined || materializedSkills.length > 0) return;
      skillPreparation ??= materializeSkills(
        selectedSkills,
        localSkillRoot,
        skillSyncLimits,
      ).then((materialized) => {
        materializedSkills = materialized;
        selectedSkillDefinitions = loadSelectedSkillDefinitions(materializedSkills);
      }).finally(() => {
        skillPreparation = undefined;
      });
      await skillPreparation;
    };
    const sandboxSession = new SandboxSession({
      hostWorkspaceRoot: process.cwd(),
      initializeSandbox: async (sandboxHandle) => {
        if (sharedSkillRoot !== undefined) {
          skillSyncReport = await uploadSkills(
            sandboxHandle,
            materializedSkills,
            sharedSkillRoot,
            skillSyncLimits,
            verifyUploadedSkills,
          );
        }
      },
    });

    const ensureRemoteTools = () => {
      if (remoteToolsRegistered) return;
      // Registering replaces Pi's local tool implementations, so defer it
      // until this session has explicitly selected remote execution.
      remoteToolsRegistered = true;
      registerOpenSandboxTools(
        pi,
        () => sandboxSession.requireActiveSandboxHandle(),
        () => sandboxSession.getHostWorkspaceRoot(),
      );
    };
    const sandboxRuntime: OpenSandboxRuntime = {
      session: sandboxSession,
      activate: async () => {
        ensureRemoteTools();
        if (sharedSkillRoot !== undefined) await ensureSelectedSkills();
        const restoreTarget = persistedSandboxState.active && persistedSandboxState.sandboxId
          ? {
            sandboxId: persistedSandboxState.sandboxId,
            owned: persistedSandboxState.owned === true,
          }
          : undefined;
        const sandboxHandle = await sandboxSession.ensureActiveSandboxHandle(
          sandboxSettings,
          restoreTarget,
        );
        persistedSandboxState = {
          active: true,
          sandboxId: sandboxHandle.id,
          owned: sandboxHandle.isOwnedByExtension,
        };
        pi.appendEntry(STATE_ENTRY_TYPE, persistedSandboxState);
        return sandboxHandle;
      },
      ...(sharedSkillRoot === undefined
        ? {}
        : { getSkillReport: () => skillSyncReport }),
    };

    registerOpenSandboxCommand(pi, {
      ...commandOptions,
      runtime: sandboxRuntime,
    });

    pi.on("session_start", async (event, ctx) => {
      sandboxSession.setPiSessionContext(
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getCwd(),
      );
      // JSONL state is separate from the live connection so a paused sandbox
      // can be restored after Pi itself is resumed.
      persistedSandboxState = readPersistedSandboxState(ctx);
      if (event.reason === "fork") {
        persistedSandboxState = { active: false };
        sandboxSession.clearStartupFailure();
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        pi.appendEntry(STATE_ENTRY_TYPE, persistedSandboxState);
        return;
      }
      if (!persistedSandboxState.active && pi.getFlag("opensandbox")) {
        persistedSandboxState = { active: true };
      }
      if (!persistedSandboxState.active) {
        sandboxSession.clearStartupFailure();
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        return;
      }
      ensureRemoteTools();
      const restoring = persistedSandboxState.sandboxId !== undefined;
      ctx.ui.setStatus(
        "opensandbox",
        restoring ? "opensandbox: restoring…" : "opensandbox: starting…",
      );
      await initializeSessionSandbox(
        sandboxRuntime,
        ctx,
        restoring,
      );
    });

    pi.on("session_tree", async (_event, ctx) => {
      sandboxSession.setPiSessionContext(
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getCwd(),
      );
      const persistedBranchState = readPersistedSandboxState(ctx);
      if (sandboxSession.getLifecycleState() !== "inactive") {
        if (!isSamePersistedSandboxState(persistedBranchState, persistedSandboxState)) {
          pi.appendEntry(STATE_ENTRY_TYPE, persistedSandboxState);
        }
        return;
      }
      persistedSandboxState = persistedBranchState;
      if (!persistedSandboxState.active) {
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        return;
      }
      ensureRemoteTools();
      const restoring = persistedSandboxState.sandboxId !== undefined;
      ctx.ui.setStatus(
        "opensandbox",
        restoring ? "opensandbox: restoring…" : "opensandbox: starting…",
      );
      await initializeSessionSandbox(sandboxRuntime, ctx, restoring);
    });

    pi.on("resources_discover", () => persistedSandboxState.active
      ? { skillPaths: materializedSkills.map((skill) => skill.skillFile) }
      : {});

    pi.on("before_agent_start", async (event) => {
      if (sandboxSession.getLifecycleState() === "inactive") return undefined;
      const sandboxHandle = await sandboxSession.requireActiveSandboxHandle();
      event.systemPromptOptions.cwd = sandboxHandle.sandboxWorkspaceRoot;
      event.systemPromptOptions.skills = buildRemoteSkills(
        selectedSkillDefinitions,
        skillSyncReport,
      );
      event.systemPromptOptions.sections.opensandbox =
        `Sandbox ID: ${sandboxHandle.id}\n`
        + "Pi tools bash, read, write, edit, ls, find, and grep execute in this "
        + "OpenSandbox sandbox. User ! shell commands also execute there.";
    });

    pi.on("input", async (event, ctx) => {
      if (sandboxSession.getLifecycleState() === "inactive" || !event.text.startsWith("/skill:")) {
        return { action: "continue" };
      }
      const skillCommandMatch = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(event.text);
      if (!skillCommandMatch) return { action: "continue" };

      const selectedSkill = materializedSkills.find(
        (candidate) => candidate.name === skillCommandMatch[1],
      );
      const uploadedSkill = skillSyncReport?.skills.find(
        (candidate) => candidate.name === skillCommandMatch[1],
      );
      if (!selectedSkill || !uploadedSkill) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Skill "${skillCommandMatch[1]}" is not selected for this OpenSandbox session.`,
            "error",
          );
        }
        return { action: "handled" };
      }

      const skillBody = stripFrontmatter(
        await readFile(selectedSkill.skillFile, "utf8"),
      ).trim();
      const skillBlock = `<skill name="${escapeXml(selectedSkill.name)}" location="${escapeXml(uploadedSkill.skillFile)}">\n`
        + `References are relative to ${dirnamePosix(uploadedSkill.skillFile)}.\n\n`
        + `${skillBody}\n</skill>`;
      const skillArguments = skillCommandMatch[2]?.trim();
      return {
        action: "transform",
        text: skillArguments ? `${skillBlock}\n\n${skillArguments}` : skillBlock,
      };
    });

    pi.on("session_shutdown", async () => {
      await sandboxSession.releaseForShutdown();
    });
  };
}

function loadSelectedSkillDefinitions(materializedSkills: MaterializedSkill[]): Skill[] {
  return materializedSkills.map((materializedSkill) => {
    const loaded = loadSkillsFromDir({
      dir: materializedSkill.hostDir,
      source: "pi-opensandbox",
    }).skills.find((skill) => skill.filePath === materializedSkill.skillFile);
    if (!loaded) {
      throw new Error(`Selected Skill has no valid description: ${materializedSkill.skillFile}`);
    }
    return { ...loaded, name: materializedSkill.name };
  });
}

function buildRemoteSkills(
  selectedSkillDefinitions: Skill[],
  skillSyncReport: SkillSyncReport | undefined,
): Skill[] {
  if (selectedSkillDefinitions.length === 0) return [];
  if (!skillSyncReport) throw new Error("OpenSandbox Skills are not ready");

  return selectedSkillDefinitions.map((skillDefinition) => {
    const uploadedSkill = skillSyncReport.skills.find(
      (candidate) => candidate.name === skillDefinition.name,
    );
    if (!uploadedSkill) {
      throw new Error(`OpenSandbox Skill was not uploaded: ${skillDefinition.name}`);
    }
    const baseDir = dirnamePosix(uploadedSkill.skillFile);
    return {
      ...skillDefinition,
      filePath: uploadedSkill.skillFile,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(uploadedSkill.skillFile, {
        source: "pi-opensandbox",
        scope: "temporary",
        baseDir,
      }),
    };
  });
}

function readPersistedSandboxState(ctx: ExtensionContext): PersistedSandboxState {
  let persistedState: PersistedSandboxState = {
    active: false
  };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    persistedState = {
      active: false
    };
    const entryData = entry.data as Record<string, unknown> | undefined;
    if (
      entryData?.active === true
      && entryData.sandboxId === undefined
      && entryData.owned === undefined
    ) {
      persistedState = {
        active: true
      };
    } else if (
      entryData?.active === true
      && typeof entryData.sandboxId === "string"
      && entryData.sandboxId.length > 0
      && (entryData.owned === undefined || typeof entryData.owned === "boolean")
    ) {
      persistedState = {
        active: true,
        sandboxId: entryData.sandboxId,
        ...(entryData.owned === undefined ? {} : { owned: entryData.owned }),
      };
    }
  }
  return persistedState;
}

function isSamePersistedSandboxState(
  left: PersistedSandboxState,
  right: PersistedSandboxState,
): boolean {
  return left.active === right.active
    && left.sandboxId === right.sandboxId
    && left.owned === right.owned;
}

async function initializeSessionSandbox(
  runtime: OpenSandboxRuntime,
  ctx: ExtensionContext,
  restoring: boolean,
): Promise<void> {
  try {
    const sandboxHandle = await runtime.activate();
    ctx.ui.setStatus("opensandbox", OPEN_SANDBOX_REMOTE_STATUS);
    notifyIfUiAvailable(
      ctx,
      `OpenSandbox ${sandboxHandle.startupMode}: ${sandboxHandle.id}`,
      "info",
    );
  } catch (error) {
    logOpenSandboxEvent(
      "error",
      "extension.session_start.error",
      describeOpenSandboxError(error),
    );
    ctx.ui.setStatus("opensandbox", "opensandbox: failed");
    notifyIfUiAvailable(
      ctx,
      `OpenSandbox failed to ${restoring ? "restore" : "start"}: ${getErrorMessage(error)}`,
      "error",
    );
  }
}

function notifyIfUiAvailable(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "error",
): void {
  if (!ctx.hasUI) return
  ctx.ui.notify(message, level)
}
