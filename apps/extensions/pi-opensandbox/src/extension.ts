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
  type OpenSandboxCommandRuntime,
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
 * const state: PiOpenSandboxSessionState = {
 *   active: true,
 *   sandboxId: "sandbox-123",
 *   owned: true,
 * };
 * ```
 */
export interface PiOpenSandboxSessionState {
  /** Whether the session expects subsequent tools to run remotely. */
  active: boolean;
  /** Sandbox to resume; absent while a newly created remote session starts. */
  sandboxId?: string;
  /** Whether this extension created and therefore manages the sandbox. */
  owned?: boolean;
}

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
    let desiredSessionState: PiOpenSandboxSessionState = {
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
      onReady: async (activeSandbox) => {
        if (sharedSkillRoot !== undefined) {
          skillSyncReport = await uploadSkills(
            activeSandbox,
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
        () => sandboxSession.requireActiveSandbox(),
        () => sandboxSession.getHostWorkspaceRoot(),
      );
    };
    const commandRuntime: OpenSandboxCommandRuntime = {
      session: sandboxSession,
      activate: async () => {
        ensureRemoteTools();
        if (sharedSkillRoot !== undefined) await ensureSelectedSkills();
        const restoreTarget = desiredSessionState.active && desiredSessionState.sandboxId
          ? {
            sandboxId: desiredSessionState.sandboxId,
            owned: desiredSessionState.owned === true,
          }
          : undefined;
        const activeSandbox = await sandboxSession.startSandbox(sandboxSettings, restoreTarget);
        desiredSessionState = {
          active: true,
          sandboxId: activeSandbox.id,
          owned: activeSandbox.isOwnedByExtension,
        };
        pi.appendEntry(STATE_ENTRY_TYPE, desiredSessionState);
        return activeSandbox;
      },
      ...(sharedSkillRoot === undefined
        ? {}
        : { getSkillReport: () => skillSyncReport }),
    };

    registerOpenSandboxCommand(pi, {
      ...commandOptions,
      runtime: commandRuntime,
    });

    pi.on("session_start", async (event, ctx) => {
      sandboxSession.setSessionContext(
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getCwd(),
      );
      // Desired state is persisted separately from the live connection so a
      // paused sandbox can be restored after Pi itself is resumed.
      desiredSessionState = readSessionState(ctx);
      if (event.reason === "fork") {
        desiredSessionState = { active: false };
        sandboxSession.clearFailure();
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        pi.appendEntry(STATE_ENTRY_TYPE, desiredSessionState);
        return;
      }
      if (!desiredSessionState.active && pi.getFlag("opensandbox")) {
        desiredSessionState = { active: true };
      }
      if (!desiredSessionState.active) {
        sandboxSession.clearFailure();
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        return;
      }
      ensureRemoteTools();
      const restoring = desiredSessionState.sandboxId !== undefined;
      ctx.ui.setStatus(
        "opensandbox",
        restoring ? "opensandbox: restoring…" : "opensandbox: starting…",
      );
      await initializeSessionSandbox(
        commandRuntime,
        ctx,
        restoring,
      );
    });

    pi.on("session_tree", async (_event, ctx) => {
      sandboxSession.setSessionContext(
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getCwd(),
      );
      const branchState = readSessionState(ctx);
      if (sandboxSession.getState() !== "inactive") {
        if (!sameSessionState(branchState, desiredSessionState)) {
          pi.appendEntry(STATE_ENTRY_TYPE, desiredSessionState);
        }
        return;
      }
      desiredSessionState = branchState;
      if (!desiredSessionState.active) {
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        return;
      }
      ensureRemoteTools();
      const restoring = desiredSessionState.sandboxId !== undefined;
      ctx.ui.setStatus(
        "opensandbox",
        restoring ? "opensandbox: restoring…" : "opensandbox: starting…",
      );
      await initializeSessionSandbox(commandRuntime, ctx, restoring);
    });

    pi.on("resources_discover", () => desiredSessionState.active
      ? { skillPaths: materializedSkills.map((skill) => skill.skillFile) }
      : {});

    pi.on("before_agent_start", async (event) => {
      if (sandboxSession.getState() === "inactive") return undefined;
      const activeSandbox = await sandboxSession.requireActiveSandbox();
      event.systemPromptOptions.cwd = activeSandbox.sandboxWorkspaceRoot;
      event.systemPromptOptions.skills = buildRemoteSkills(
        selectedSkillDefinitions,
        skillSyncReport,
      );
      event.systemPromptOptions.sections.opensandbox =
        `Sandbox ID: ${activeSandbox.id}\n`
        + "Pi tools bash, read, write, edit, ls, find, and grep execute in this "
        + "OpenSandbox sandbox. User ! shell commands also execute there.";
    });

    pi.on("input", async (event, ctx) => {
      if (sandboxSession.getState() === "inactive" || !event.text.startsWith("/skill:")) {
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
      await sandboxSession.shutdown();
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

function readSessionState(ctx: ExtensionContext): PiOpenSandboxSessionState {
  let sessionState: PiOpenSandboxSessionState = {
    active: false
  };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    sessionState = {
      active: false
    };
    const entryData = entry.data as Record<string, unknown> | undefined;
    if (
      entryData?.active === true
      && entryData.sandboxId === undefined
      && entryData.owned === undefined
    ) {
      sessionState = {
        active: true
      };
    } else if (
      entryData?.active === true
      && typeof entryData.sandboxId === "string"
      && entryData.sandboxId.length > 0
      && (entryData.owned === undefined || typeof entryData.owned === "boolean")
    ) {
      sessionState = {
        active: true,
        sandboxId: entryData.sandboxId,
        ...(entryData.owned === undefined ? {} : { owned: entryData.owned }),
      };
    }
  }
  return sessionState;
}

function sameSessionState(
  left: PiOpenSandboxSessionState,
  right: PiOpenSandboxSessionState,
): boolean {
  return left.active === right.active
    && left.sandboxId === right.sandboxId
    && left.owned === right.owned;
}

async function initializeSessionSandbox(
  runtime: OpenSandboxCommandRuntime,
  ctx: ExtensionContext,
  restoring: boolean,
): Promise<void> {
  try {
    const activeSandbox = await runtime.activate();
    ctx.ui.setStatus("opensandbox", OPEN_SANDBOX_REMOTE_STATUS);
    notifyIfUiAvailable(
      ctx,
      `OpenSandbox ${activeSandbox.startupMode}: ${activeSandbox.id}`,
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
