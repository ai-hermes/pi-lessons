import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  materializeSkills,
  uploadSkills,
  type SkillSyncReport,
} from "./skills.ts";
import {
  resolvePiOpenSandboxRuntimeConfig,
  type PiOpenSandboxOptions,
  type PiOpenSandboxRuntimeConfig,
} from "./config.ts";
import { registerOpenSandboxCommand } from "./config-command.ts";
import type { OpenSandboxSettings } from "./sandbox/config.ts";
import { describeOpenSandboxError, logOpenSandboxEvent } from "./sandbox/logger.ts";
import { SandboxSession } from "./sandbox/session.ts";
import { registerOpenSandboxTools } from "./sandbox/tools.ts";

export type { PiOpenSandboxOptions } from "./config.ts";

export function createPiOpenSandboxExtension(
  options: PiOpenSandboxOptions,
): ExtensionFactory {
  return createPiOpenSandboxExtensionFromConfig(
    resolvePiOpenSandboxRuntimeConfig(options),
  );
}

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
    const skills = sharedSkillRoot === undefined
      ? []
      : await materializeSkills(selectedSkills, sharedSkillRoot, skillSyncLimits);
    let report: SkillSyncReport | undefined;
    const session = new SandboxSession({
      hostWorkspaceRoot: process.cwd(),
      policy: sandboxSettings.lifecycle,
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
    let starting: Promise<void> | undefined;

    registerOpenSandboxTools(
      pi,
      () => session.getActiveSandbox(),
      () => session.getHostWorkspaceRoot(),
    );
    registerCommands(
      pi,
      session,
      skills.length > 0 ? () => report : undefined,
      installedConfigPath,
    );

    if (skills.length > 0) {
      pi.on("resources_discover", () => ({
        skillPaths: skills.map((skill) => skill.skillFile),
      }));
    }

    pi.on("session_start", async (_event, ctx) => {
      if (session.getActiveSandbox()) return;
      if (starting) return starting;
      session.setSessionContext(
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getCwd(),
      );
      starting = startSessionSandbox(session, sandboxSettings, ctx);
      try {
        await starting;
      } catch (error) {
        logOpenSandboxEvent(
          "error",
          "extension.session_start.error",
          describeOpenSandboxError(error),
        );
        notifyIfUiAvailable(
          ctx,
          `OpenSandbox failed to start: ${getErrorMessage(error)}`,
          "error",
        );
        throw error;
      } finally {
        starting = undefined;
      }
    });

    pi.on("before_agent_start", (event) => {
      const activeSandbox = session.getActiveSandbox();
      if (!activeSandbox) return undefined;
      const cwd = `Current working directory: ${activeSandbox.sandboxWorkspaceRoot} `
        + `(OpenSandbox sandbox ${activeSandbox.id})`;
      return {
        systemPrompt: event.systemPrompt.replace(/Current working directory: .*/g, cwd)
          + "\n\nYou are working in a remote OpenSandbox workspace. "
          + "All Pi file, search, and shell tools execute there.",
      };
    });

    pi.on("session_shutdown", async () => {
      if (starting) await starting;
      await session.shutdown();
    });
  };
}

function registerCommands(
  pi: ExtensionAPI,
  session: SandboxSession,
  getReport?: () => SkillSyncReport | undefined,
  installedConfigPath?: string,
): void {
  if (installedConfigPath === undefined) {
    pi.registerCommand("opensandbox", {
      description: "Show the OpenSandbox sandbox held by this session",
      handler: async (_args, ctx) => {
        const activeSandbox = session.getActiveSandbox();
        if (!activeSandbox) {
          return notifyIfUiAvailable(ctx, "No OpenSandbox sandbox is active.", "info");
        }
        notifyIfUiAvailable(ctx, [
          `OpenSandbox ${activeSandbox.id}`,
          `Workspace: ${activeSandbox.sandboxWorkspaceRoot}`,
          `Image: ${activeSandbox.imageReference}`,
        ].join("\n"), "info");
      },
    });
  } else {
    registerOpenSandboxCommand(pi, installedConfigPath, () => session.getActiveSandbox());
  }

  if (getReport) {
    pi.registerCommand("opensandbox-skills", {
      description: "Show Skills mirrored into the current OpenSandbox session",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return;
        const report = getReport();
        if (!report) return ctx.ui.notify("OpenSandbox Skills are not ready.", "info");
        const skills = report.skills.map(
          (skill) => `${skill.name} ${skill.digest.slice(0, 12)} ${skill.skillFile}`,
        );
        ctx.ui.notify([`${report.files} files, ${report.bytes} bytes`, ...skills].join("\n"), "info");
      },
    });
  }
}

async function startSessionSandbox(
  session: SandboxSession,
  sandboxSettings: OpenSandboxSettings,
  ctx: ExtensionContext,
): Promise<void> {
  const activeSandbox = await session.startSandbox(sandboxSettings);
  notifyIfUiAvailable(
    ctx,
    `OpenSandbox ${activeSandbox.startupMode}: ${activeSandbox.id}`,
    "info",
  );
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
