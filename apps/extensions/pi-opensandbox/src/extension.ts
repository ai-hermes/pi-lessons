import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname as dirnamePosix } from "node:path/posix";
import type {
  ExtensionContext,
  ExtensionFactory,
  Skill,
} from "@earendil-works/pi-coding-agent";
import {
  createSyntheticSourceInfo,
  formatSkillsForPrompt,
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
  type OpenSandboxCommandRuntime,
} from "./config-command";
import { describeOpenSandboxError, logOpenSandboxEvent } from "./sandbox/logger";
import { SandboxSession } from "./sandbox/session";
import { registerOpenSandboxTools } from "./sandbox/tools";

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
  installedConfigPath?: string,
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
    const skills = sharedSkillRoot === undefined
      ? []
      : await materializeSkills(selectedSkills, localSkillRoot, skillSyncLimits);
    const skillDefinitions = loadSelectedSkillDefinitions(skills);
    let report: SkillSyncReport | undefined;
    let desiredState: PiOpenSandboxSessionState = { active: false };
    let remoteToolsRegistered = false;
    const session = new SandboxSession({
      hostWorkspaceRoot: process.cwd(),
      onReady: async (activeSandbox) => {
        if (sharedSkillRoot !== undefined) {
          report = await uploadSkills(
            activeSandbox,
            skills,
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
        () => session.requireActiveSandbox(),
        () => session.getHostWorkspaceRoot(),
      );
    };
    const commandRuntime: OpenSandboxCommandRuntime = {
      session,
      activate: async () => {
        ensureRemoteTools();
        const restoreTarget = desiredState.active && desiredState.sandboxId
          ? {
            sandboxId: desiredState.sandboxId,
            owned: desiredState.owned === true,
          }
          : undefined;
        const activeSandbox = await session.startSandbox(sandboxSettings, restoreTarget);
        desiredState = {
          active: true,
          sandboxId: activeSandbox.id,
          owned: activeSandbox.isOwnedByExtension,
        };
        pi.appendEntry(STATE_ENTRY_TYPE, desiredState);
        return activeSandbox;
      },
      ...(skills.length === 0 ? {} : { getSkillReport: () => report }),
    };

    registerOpenSandboxCommand(pi, installedConfigPath, commandRuntime);

    pi.on("session_start", async (event, ctx) => {
      session.setSessionContext(
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getCwd(),
      );
      // Desired state is persisted separately from the live connection so a
      // paused sandbox can be restored after Pi itself is resumed.
      desiredState = readSessionState(ctx);
      if (event.reason === "fork") {
        desiredState = { active: false };
        session.clearFailure();
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        pi.appendEntry(STATE_ENTRY_TYPE, desiredState);
        return;
      }
      if (!desiredState.active && pi.getFlag("opensandbox") === true) {
        desiredState = { active: true };
        pi.appendEntry(STATE_ENTRY_TYPE, desiredState);
      }
      if (!desiredState.active) {
        session.clearFailure();
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        return;
      }
      ensureRemoteTools();
      const restoring = desiredState.sandboxId !== undefined;
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
      session.setSessionContext(
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getCwd(),
      );
      const branchState = readSessionState(ctx);
      if (session.getMode() !== "local") {
        if (!sameSessionState(branchState, desiredState)) {
          pi.appendEntry(STATE_ENTRY_TYPE, desiredState);
        }
        return;
      }
      desiredState = branchState;
      if (!desiredState.active) {
        ctx.ui.setStatus("opensandbox", "opensandbox: -");
        return;
      }
      ensureRemoteTools();
      const restoring = desiredState.sandboxId !== undefined;
      ctx.ui.setStatus(
        "opensandbox",
        restoring ? "opensandbox: restoring…" : "opensandbox: starting…",
      );
      await initializeSessionSandbox(commandRuntime, ctx, restoring);
    });

    pi.on("resources_discover", () => desiredState.active
      ? { skillPaths: skills.map((skill) => skill.skillFile) }
      : {});

    pi.on("before_agent_start", async (event) => {
      if (session.getMode() === "local") return undefined;
      const activeSandbox = await session.requireActiveSandbox();
      const remoteSkills = buildRemoteSkills(skillDefinitions, report);
      const skillReadTool = getSkillReadTool(event.systemPromptOptions?.selectedTools);
      const localSkillCatalog = skillReadTool
        ? formatSkillsForPrompt(event.systemPromptOptions?.skills ?? [], skillReadTool)
        : "";
      const remoteSkillCatalog = skillReadTool
        ? formatSkillsForPrompt(remoteSkills, skillReadTool)
        : "";
      const cwd = `Current working directory: ${activeSandbox.sandboxWorkspaceRoot} `
        + `(OpenSandbox sandbox ${activeSandbox.id})`;
      const skillPrompt = localSkillCatalog
        ? event.systemPrompt.replace(localSkillCatalog, remoteSkillCatalog)
        : event.systemPrompt + remoteSkillCatalog;
      return {
        systemPrompt: skillPrompt
          .replace(/Current working directory: .*/g, cwd)
          + "\n\nYou are working in a remote OpenSandbox workspace. "
          + "All Pi file, search, and shell tools execute there.",
      };
    });

    pi.on("input", async (event, ctx) => {
      if (session.getMode() === "local" || !event.text.startsWith("/skill:")) {
        return { action: "continue" };
      }
      const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(event.text);
      if (!match) return { action: "continue" };

      const skill = skills.find((candidate) => candidate.name === match[1]);
      const remoteSkill = report?.skills.find((candidate) => candidate.name === match[1]);
      if (!skill || !remoteSkill) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Skill "${match[1]}" is not selected for this OpenSandbox session.`,
            "error",
          );
        }
        return { action: "handled" };
      }

      const body = stripFrontmatter(await readFile(skill.skillFile, "utf8")).trim();
      const skillBlock = `<skill name="${escapeXml(skill.name)}" location="${escapeXml(remoteSkill.skillFile)}">\n`
        + `References are relative to ${dirnamePosix(remoteSkill.skillFile)}.\n\n`
        + `${body}\n</skill>`;
      const args = match[2]?.trim();
      return {
        action: "transform",
        text: args ? `${skillBlock}\n\n${args}` : skillBlock,
      };
    });

    pi.on("session_shutdown", async () => {
      await session.shutdown();
    });
  };
}

function loadSelectedSkillDefinitions(skills: MaterializedSkill[]): Skill[] {
  return skills.map((materialized) => {
    const loaded = loadSkillsFromDir({
      dir: materialized.hostDir,
      source: "pi-opensandbox",
    }).skills.find((skill) => skill.filePath === materialized.skillFile);
    if (!loaded) {
      throw new Error(`Selected Skill has no valid description: ${materialized.skillFile}`);
    }
    return { ...loaded, name: materialized.name };
  });
}

function buildRemoteSkills(
  skills: Skill[],
  report: SkillSyncReport | undefined,
): Skill[] {
  if (skills.length === 0) return [];
  if (!report) throw new Error("OpenSandbox Skills are not ready");

  return skills.map((skill) => {
    const uploaded = report.skills.find((candidate) => candidate.name === skill.name);
    if (!uploaded) throw new Error(`OpenSandbox Skill was not uploaded: ${skill.name}`);
    const baseDir = dirnamePosix(uploaded.skillFile);
    return {
      ...skill,
      filePath: uploaded.skillFile,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(uploaded.skillFile, {
        source: "pi-opensandbox",
        scope: "temporary",
        baseDir,
      }),
    };
  });
}

function getSkillReadTool(
  selectedTools: string[] | undefined,
): "read" | "bash" | undefined {
  const tools = selectedTools ?? ["read", "bash", "edit", "write"];
  if (tools.includes("read")) return "read";
  if (tools.includes("bash")) return "bash";
  return undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function readSessionState(ctx: ExtensionContext): PiOpenSandboxSessionState {
  let state: PiOpenSandboxSessionState = { active: false };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    state = { active: false };
    const data = entry.data as Record<string, unknown> | undefined;
    if (
      data?.active === true
      && data.sandboxId === undefined
      && data.owned === undefined
    ) {
      state = { active: true };
    } else if (
      data?.active === true
      && typeof data.sandboxId === "string"
      && data.sandboxId.length > 0
      && (data.owned === undefined || typeof data.owned === "boolean")
    ) {
      state = {
        active: true,
        sandboxId: data.sandboxId,
        ...(data.owned === undefined ? {} : { owned: data.owned }),
      };
    }
  }
  return state;
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
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
