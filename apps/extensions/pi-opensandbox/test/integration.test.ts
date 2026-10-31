import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Sandbox } from "@alibaba-group/opensandbox";
import extension, { createPiOpenSandboxExtension } from "../dist/index.js";
import { createPiOpenSandboxExtensionFromConfig } from "../dist/extension.js";
import { resolvePiOpenSandboxRuntimeConfig } from "../dist/config.js";
import {
  describeSkillSync,
  describeUploadedSkills,
  OPEN_SANDBOX_REMOTE_STATUS,
  registerOpenSandboxCommand,
} from "../dist/config-command.js";
import { materializeSkills, uploadSkills } from "../dist/skills.js";
import { resolveOpenSandboxSettings } from "../dist/sandbox/config.js";
import { createBashOperations } from "../dist/sandbox/tool-operations.js";
import { ActiveOpenSandbox } from "../dist/sandbox/client.js";
import { describeOpenSandboxError } from "../dist/sandbox/logger.js";
import { createFindOperations, runRemoteGrep } from "../dist/sandbox/search.js";
import { SandboxSession } from "../dist/sandbox/session.js";

function fakePi(initialFlags = {}) {
  const handlers = new Map();
  const commands = [];
  const commandHandlers = new Map();
  const tools = [];
  const toolDefinitions = new Map();
  const entries = [];
  const flags = new Map(Object.entries(initialFlags));
  return {
    handlers,
    commands,
    commandHandlers,
    tools,
    toolDefinitions,
    entries,
    flags,
    api: {
      on: (name, handler) => handlers.set(name, handler),
      registerFlag: (name, options) => {
        if (!flags.has(name) && options.default !== undefined) {
          flags.set(name, options.default);
        }
      },
      getFlag: (name) => flags.get(name),
      registerCommand: (name, command) => {
        commands.push(name);
        commandHandlers.set(name, command.handler);
      },
      registerTool: (tool) => {
        tools.push(tool.name);
        toolDefinitions.set(tool.name, tool);
      },
      appendEntry: (customType, data) => entries.push({ customType, data }),
    },
  };
}

function activeSandbox(sandboxClient, overrides = {}) {
  return new ActiveOpenSandbox({
    defaultCommandTimeoutSeconds: 120,
    hostWorkspaceRoot: process.cwd(),
    imageReference: "test",
    maxFileReadBytes: 1024,
    readableResourceRoots: [],
    sandboxClient,
    sandboxWorkspaceRoot: "/workspace",
    startupMode: "created",
    owned: overrides.startupMode === undefined || overrides.startupMode === "created",
    ...overrides,
  });
}

function remoteSkillSandbox(remoteRoot) {
  const remote = new Map();
  const remoteModes = new Map();
  const activationCommands = [];
  let failActivation = false;
  let uploadFailures = 0;
  let limitedReads = 0;
  let writeCalls = 0;
  const sandbox = {
    id: "skill-upload",
    renew: async () => {},
    kill: async () => {},
    close: async () => {},
    commands: {
      run: async (command, _options, handlers) => {
        handlers.onInit({ id: "skill-activation" });
        if (command.startsWith("set -eu")) {
          activationCommands.push(command);
          assert.equal(spawnSync("/bin/sh", ["-n"], { input: command }).status, 0);
          if (failActivation) return { exitCode: 1 };
          const manifestPath = [...remote.keys()].find(
            (path) => path.startsWith(`${remoteRoot}/.staging-`)
              && path.endsWith("/.pi-skills-manifest.json"),
          );
          assert.ok(manifestPath);
          const stagingRoot = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
          const previousManifest = remote.get(`${remoteRoot}/.pi-skills-manifest.json`);
          const previousNames = previousManifest === undefined
            ? []
            : Object.keys(JSON.parse(previousManifest.toString()).skills);
          const nextNames = Object.keys(JSON.parse(remote.get(manifestPath).toString()).skills);
          const staged = [...remote.entries()]
            .filter(([path]) => path.startsWith(`${stagingRoot}/`))
            .map(([path, data]) => [
              `${remoteRoot}/${path.slice(stagingRoot.length + 1)}`,
              data,
              remoteModes.get(path),
            ]);
          const managedNames = new Set([
            ...previousNames,
            ...nextNames,
            ".pi-skills-manifest.json",
          ]);
          for (const path of [...remote.keys()]) {
            const relativePath = path.slice(remoteRoot.length + 1);
            const topLevelName = relativePath.split("/", 1)[0];
            if (managedNames.has(topLevelName)) {
              remote.delete(path);
              remoteModes.delete(path);
            }
          }
          for (const [path, data, mode] of staged) {
            remote.set(path, data);
            remoteModes.set(path, mode);
          }
          for (const path of [...remote.keys()]) {
            if (path.startsWith(`${stagingRoot}/`)) {
              remote.delete(path);
              remoteModes.delete(path);
            }
          }
        } else {
          for (const path of [...remote.keys()]) {
            if (path.startsWith(`${remoteRoot}/.staging-`)) {
              remote.delete(path);
              remoteModes.delete(path);
            }
          }
        }
        return { exitCode: 0 };
      },
      interrupt: async () => {},
    },
    files: {
      createDirectories: async () => {},
      getFileInfo: async (paths) => {
        if (paths.some((path) => !remote.has(path))) {
          throw Object.assign(new Error("file not found"), { statusCode: 404 });
        }
        return Object.fromEntries(paths.map((path) => [path, { path }]));
      },
      writeFiles: async (entries) => {
        writeCalls += 1;
        if (uploadFailures > 0) {
          uploadFailures -= 1;
          throw Object.assign(new Error("Upload failed (status=500)"), {
            statusCode: 500,
          });
        }
        for (const entry of entries) {
          remote.set(entry.path, Buffer.from(entry.data));
          remoteModes.set(entry.path, entry.mode);
        }
      },
      readBytesStream: async function* (path, options) {
        const data = remote.get(path);
        if (options?.limit !== undefined) {
          limitedReads += 1;
          yield data.subarray(0, -1);
        } else {
          yield data;
        }
      },
    },
  };
  return {
    remote,
    remoteModes,
    sandbox,
    activationCommands,
    failNextActivation: () => {
      failActivation = true;
    },
    failUploads: (count) => {
      uploadFailures = count;
    },
    limitedReads: () => limitedReads,
    writeCalls: () => writeCalls,
  };
}

function sessionContext(branch = [], sessionId = "session", statuses = []) {
  return {
    hasUI: true,
    sessionManager: {
      getBranch: () => branch,
      getCwd: () => process.cwd(),
      getSessionId: () => sessionId,
    },
    ui: {
      notify: () => {},
      setStatus: (_key, text) => statuses.push(text),
    },
  };
}

test("ActiveOpenSandbox resolves readable and writable paths through one interface", () => {
  const sandbox = activeSandbox(
    { id: "paths" },
    { readableResourceRoots: ["/resources"] },
  );

  assert.equal(sandbox.id, "paths");
  assert.equal(sandbox.startupMode, "created");
  assert.equal(sandbox.isOwnedByExtension, true);
  assert.equal(sandbox.resolveReadablePath("src/index.ts"), "/workspace/src/index.ts");
  assert.equal(
    sandbox.resolveReadablePath(join(process.cwd(), "src", "index.ts")),
    "/workspace/src/index.ts",
  );
  assert.equal(sandbox.resolveReadablePath("/resources/SKILL.md"), "/resources/SKILL.md");
  assert.equal(sandbox.resolveWritablePath("/workspace/output.txt"), "/workspace/output.txt");
  assert.throws(
    () => sandbox.resolveWritablePath("/resources/output.txt"),
    /escapes the host workspace/,
  );
  assert.throws(
    () => sandbox.resolveReadablePath("../outside"),
    /accept only paths inside/,
  );
  assert.throws(
    () => sandbox.resolveReadablePath("file:///workspace/input.txt"),
    /accept only paths inside/,
  );
});

test("ActiveOpenSandbox enforces read limits and external cleanup ownership", async () => {
  let closeCalls = 0;
  let killCalls = 0;
  const sandbox = activeSandbox({
    id: "connected",
    close: async () => { closeCalls += 1; },
    kill: async () => { killCalls += 1; },
    files: {
      readBytesStream: async function* () {
        yield Buffer.from("large");
      },
    },
  }, {
    maxFileReadBytes: 4,
    startupMode: "connected",
  });

  assert.equal(sandbox.isOwnedByExtension, false);
  await assert.rejects(sandbox.readFile("large.txt"), /4-byte OpenSandbox read limit/);
  await sandbox.cleanupAfterStartFailure();
  assert.equal(killCalls, 0);
  assert.equal(closeCalls, 1);
});

test("ActiveOpenSandbox treats missing remote files as absent", async () => {
  const missing = Object.assign(new Error("file not found"), { statusCode: 404 });
  const sandbox = activeSandbox({
    id: "missing-file",
    files: {
      getFileInfo: async () => {
        throw missing;
      },
    },
  });

  assert.equal(await sandbox.getFileInfo("missing.txt"), undefined);
});

test("failed initialization pauses a resumed owned sandbox", async () => {
  let closeCalls = 0;
  let pauseCalls = 0;
  const sandbox = activeSandbox({
    id: "resumed",
    close: async () => { closeCalls += 1; },
    pause: async () => { pauseCalls += 1; },
  }, {
    startupMode: "resumed",
    owned: true,
  });

  await sandbox.cleanupAfterStartFailure();
  assert.equal(pauseCalls, 1);
  assert.equal(closeCalls, 1);
});

test("new sandboxes allow network access unless restrictions are configured", async (t) => {
  const originalCreate = Sandbox.create;
  const createOptions = [];
  Sandbox.create = async (options) => {
    createOptions.push(options);
    return {
      id: `sandbox-${createOptions.length}`,
      files: { createDirectories: async () => {} },
    };
  };
  t.after(() => { Sandbox.create = originalCreate; });

  await ActiveOpenSandbox.start(
    resolveOpenSandboxSettings({ domain: "sandbox.example.test", image: "test" }),
    process.cwd(),
    "default-network",
  );
  await ActiveOpenSandbox.start(
    resolveOpenSandboxSettings({
      domain: "sandbox.example.test",
      image: "test",
      networkAllowlist: ["registry.npmmirror.com"],
    }),
    process.cwd(),
    "allowlist-network",
  );

  assert.deepEqual(createOptions[0].networkPolicy, { defaultAction: "allow" });
  assert.deepEqual(createOptions[1].networkPolicy, {
    defaultAction: "deny",
    egress: [{ action: "allow", target: "registry.npmmirror.com" }],
  });
});

test("package manifest exposes a loadable Pi extension", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@ai.hermes/pi-opensandbox");
  assert.deepEqual(pkg.pi.extensions, ["./dist/index.js"]);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.keywords.includes("pi-extension"));
  assert.equal(pkg.publishConfig.access, "public");
  await lstat(new URL("../dist/index.js", import.meta.url));
  await lstat(new URL(`../${pkg.main}`, import.meta.url));
});

test("Pi loads the built package and extensionless TypeScript source", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-opensandbox-layout-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const packageDir = join(temp, "extension");
  await mkdir(packageDir);
  await cp(new URL("../dist", import.meta.url), join(packageDir, "dist"), { recursive: true });
  await cp(new URL("../package.json", import.meta.url), join(packageDir, "package.json"));
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(packageDir, "node_modules"), "dir");
  await assert.rejects(lstat(join(packageDir, "src")), { code: "ENOENT" });

  const previous = process.env.PI_OPENSANDBOX_CONFIG;
  const previousFile = process.env.PI_OPENSANDBOX_CONFIG_FILE;
  process.env.PI_OPENSANDBOX_CONFIG = JSON.stringify({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
  });
  delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_OPENSANDBOX_CONFIG;
    else process.env.PI_OPENSANDBOX_CONFIG = previous;
    if (previousFile === undefined) delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
    else process.env.PI_OPENSANDBOX_CONFIG_FILE = previousFile;
  });

  const loader = new DefaultResourceLoader({
    cwd: temp,
    agentDir: join(temp, "agent"),
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [packageDir],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].resolvedPath, join(packageDir, "dist/index.js"));
  assert.ok(extensions[0].commands.has("opensandbox"));
  assert.equal(extensions[0].commands.size, 1);
  assert.equal(extensions[0].tools.has("bash"), false);
  assert.ok(extensions[0].handlers.has("session_start"));

  const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const sourceLoader = new DefaultResourceLoader({
    cwd: temp,
    agentDir: join(temp, "source-agent"),
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [sourcePath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await sourceLoader.reload();
  const sourceResult = sourceLoader.getExtensions();
  assert.deepEqual(sourceResult.errors, []);
  assert.equal(sourceResult.extensions[0].resolvedPath, sourcePath);
});

test("default Pi entry reads standalone configuration", async (t) => {
  const previous = process.env.PI_OPENSANDBOX_CONFIG;
  process.env.PI_OPENSANDBOX_CONFIG = JSON.stringify({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
  });
  t.after(() => {
    if (previous === undefined) delete process.env.PI_OPENSANDBOX_CONFIG;
    else process.env.PI_OPENSANDBOX_CONFIG = previous;
  });

  const pi = fakePi();
  await extension(pi.api);
  assert.deepEqual(pi.commands, ["opensandbox"]);
  assert.deepEqual(pi.tools, []);
  assert.deepEqual([...pi.handlers.keys()].sort(), [
    "before_agent_start",
    "input",
    "resources_discover",
    "session_shutdown",
    "session_start",
    "session_tree",
  ]);

  const notifications = [];
  await pi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    mode: "tui",
    ui: {
      select: async () => "Status",
      notify: (message) => notifications.push(message),
    },
  });
  assert.match(notifications[0], /Source: environment variables/);
  assert.match(notifications[0], /Domain: sandbox\.example\.test/);
  assert.match(notifications[0], /Image: test/);
  assert.match(notifications[0], /Current sandbox: not active/);
  assert.match(notifications[0], /Skills: not configured/);
});

test("Skill upload state is available for status displays", () => {
  const runtime = {
    getSkillReport: () => undefined,
  };
  assert.equal(describeSkillSync(), "Skills: not configured");
  assert.equal(describeSkillSync(runtime), "Skills: pending");
  assert.equal(OPEN_SANDBOX_REMOTE_STATUS, "opensandbox: remote ✓");
  assert.equal(describeUploadedSkills(runtime), "OpenSandbox Skills are not ready.");

  runtime.getSkillReport = () => ({
    bytes: 17176,
    files: 7,
    remoteRoot: "/tmp/pi-opensandbox-lark/skills",
    skills: [{ name: "lark-shared", digest: "digest", skillFile: "SKILL.md" }],
  });
  assert.equal(
    describeSkillSync(runtime),
    "Skills: uploaded (1 skill, 7 files, 17176 bytes)",
  );
  assert.equal(
    describeUploadedSkills(runtime),
    "7 files, 17176 bytes\nlark-shared digest SKILL.md",
  );
});

test("default Pi entry stays local until user configuration is enabled", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-opensandbox-agent-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousInline = process.env.PI_OPENSANDBOX_CONFIG;
  const previousFile = process.env.PI_OPENSANDBOX_CONFIG_FILE;
  process.env.PI_CODING_AGENT_DIR = temp;
  delete process.env.PI_OPENSANDBOX_CONFIG;
  delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousInline === undefined) delete process.env.PI_OPENSANDBOX_CONFIG;
    else process.env.PI_OPENSANDBOX_CONFIG = previousInline;
    if (previousFile === undefined) delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
    else process.env.PI_OPENSANDBOX_CONFIG_FILE = previousFile;
  });

  const pi = fakePi();
  await extension(pi.api);
  assert.deepEqual(pi.commands, ["opensandbox"]);
  assert.deepEqual(pi.tools, []);
  assert.deepEqual([...pi.handlers.keys()], ["session_start"]);
  await pi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    ui: {
      select: async (_title, actions) => {
        assert.deepEqual(actions, ["Enable OpenSandbox"]);
        return undefined;
      },
    },
  });

  const requested = fakePi({ opensandbox: true });
  await extension(requested.api);
  const notifications = [];
  const statuses = [];
  requested.handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    {
      ...sessionContext([], "session"),
      ui: {
        notify: (message) => notifications.push(message),
        setStatus: (_key, text) => statuses.push(text),
      },
    },
  );
  assert.deepEqual(statuses, ["opensandbox: failed"]);
  assert.match(notifications[0], /not enabled or configured/);
});

test("default Pi entry keeps configured execution local", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-opensandbox-enabled-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousInline = process.env.PI_OPENSANDBOX_CONFIG;
  const previousFile = process.env.PI_OPENSANDBOX_CONFIG_FILE;
  process.env.PI_CODING_AGENT_DIR = temp;
  delete process.env.PI_OPENSANDBOX_CONFIG;
  delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousInline === undefined) delete process.env.PI_OPENSANDBOX_CONFIG;
    else process.env.PI_OPENSANDBOX_CONFIG = previousInline;
    if (previousFile === undefined) delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
    else process.env.PI_OPENSANDBOX_CONFIG_FILE = previousFile;
  });
  await mkdir(join(temp, "extensions"));
  await writeFile(join(temp, "extensions", "opensandbox.json"), JSON.stringify({
    enabled: true,
    sandboxConfig: {
      domain: "sandbox.example.test",
      image: "image",
    },
  }));

  const pi = fakePi();
  await extension(pi.api);
  assert.deepEqual(pi.commands, ["opensandbox"]);
  assert.deepEqual(pi.tools, []);
  assert.ok(pi.handlers.has("session_start"));
  assert.ok(pi.handlers.has("session_shutdown"));

  await pi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    ui: {
      select: async (_title, actions) => {
        assert.ok(actions.includes("Status"));
        assert.ok(actions.includes("Configure"));
        assert.ok(actions.includes("Disable"));
        assert.equal(actions.includes("Skills"), false);
        assert.equal(actions.includes("OpenSandbox session running"), false);
        assert.equal(actions.includes("Start session"), false);
        assert.equal(actions.includes("End session"), false);
        return undefined;
      },
    },
  });
});

test("configuration command writes user config and reloads", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-opensandbox-command-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousInline = process.env.PI_OPENSANDBOX_CONFIG;
  const previousFile = process.env.PI_OPENSANDBOX_CONFIG_FILE;
  process.env.PI_CODING_AGENT_DIR = temp;
  delete process.env.PI_OPENSANDBOX_CONFIG;
  delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousInline === undefined) delete process.env.PI_OPENSANDBOX_CONFIG;
    else process.env.PI_OPENSANDBOX_CONFIG = previousInline;
    if (previousFile === undefined) delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
    else process.env.PI_OPENSANDBOX_CONFIG_FILE = previousFile;
  });

  const pi = fakePi();
  await extension(pi.api);
  const notifications = [];
  let reloads = 0;
  const inputs = ["sandbox.example.test", "image", "super-secret"];
  await pi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    mode: "tui",
    reload: async () => { reloads += 1; },
    ui: {
      select: async () => "Enable OpenSandbox",
      input: async () => inputs.shift(),
      notify: (message) => notifications.push(message),
    },
  });

  const stored = JSON.parse(await readFile(
    join(temp, "extensions", "opensandbox.json"),
    "utf8",
  ));
  assert.equal(stored.sandboxConfig.apiKey, "super-secret");
  assert.equal(reloads, 1);
  assert.equal(notifications.some((message) => message.includes("super-secret")), false);
});

test("disabled OpenSandbox can be enabled without losing its configuration", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-opensandbox-disabled-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const previousInline = process.env.PI_OPENSANDBOX_CONFIG;
  const previousFile = process.env.PI_OPENSANDBOX_CONFIG_FILE;
  delete process.env.PI_OPENSANDBOX_CONFIG;
  delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
  t.after(() => {
    if (previousInline === undefined) delete process.env.PI_OPENSANDBOX_CONFIG;
    else process.env.PI_OPENSANDBOX_CONFIG = previousInline;
    if (previousFile === undefined) delete process.env.PI_OPENSANDBOX_CONFIG_FILE;
    else process.env.PI_OPENSANDBOX_CONFIG_FILE = previousFile;
  });
  const configPath = join(temp, "opensandbox.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    sandboxConfig: {
      domain: "sandbox.example.test",
      image: "image",
    },
  }));
  const pi = fakePi();
  registerOpenSandboxCommand(pi.api, configPath);
  let reloads = 0;
  await pi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    reload: async () => { reloads += 1; },
    ui: {
      select: async (_title, actions) => {
        assert.deepEqual(actions, ["Enable OpenSandbox"]);
        return "Enable OpenSandbox";
      },
      notify: () => {},
    },
  });
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(stored.enabled, true);
  assert.equal(stored.sandboxConfig.image, "image");
  assert.equal(reloads, 1);

  const remotePi = fakePi();
  registerOpenSandboxCommand(remotePi.api, configPath, {
    session: {
      getMode: () => "remote",
    },
    activate: async () => {
      throw new Error("not used");
    },
    getSkillReport: () => ({
      bytes: 1,
      files: 1,
      remoteRoot: "/tmp/skills",
      skills: [{ digest: "digest", name: "test", skillFile: "/tmp/skills/test/SKILL.md" }],
    }),
  });
  await remotePi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    ui: {
      select: async (_title, actions) => {
        assert.deepEqual(actions, [
          "OpenSandbox session running",
          "Skills",
          "Disable",
        ]);
        return undefined;
      },
    },
  });
});

test("--opensandbox starts the current session remotely and persists owned state", async (t) => {
  const originalStart = ActiveOpenSandbox.start;
  const active = activeSandbox({
    id: "created-by-extension",
    renew: async () => {},
    pause: async () => {},
    close: async () => {},
  });
  let starts = 0;
  ActiveOpenSandbox.start = async () => {
    starts += 1;
    return active;
  };
  t.after(() => { ActiveOpenSandbox.start = originalStart; });

  const config = resolvePiOpenSandboxRuntimeConfig({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
  });
  const local = fakePi();
  await createPiOpenSandboxExtensionFromConfig(config)(local.api);
  const statuses = [];
  await local.handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    sessionContext([], "session", statuses),
  );
  assert.deepEqual(local.handlers.get("resources_discover")(), {});
  assert.equal(starts, 0);
  assert.deepEqual(local.tools, []);

  const remote = fakePi({ opensandbox: true });
  await createPiOpenSandboxExtensionFromConfig(config)(remote.api);
  const remoteStatuses = [];
  await remote.handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    sessionContext([], "remote-session", remoteStatuses),
  );
  assert.deepEqual(remote.handlers.get("resources_discover")(), { skillPaths: [] });
  assert.equal(starts, 1);
  assert.ok(remote.tools.includes("bash"));
  assert.deepEqual(remote.entries.at(-1), {
    customType: "pi-opensandbox-state",
    data: {
      active: true,
      sandboxId: "created-by-extension",
      owned: true,
    },
  });
  assert.deepEqual(statuses, ["opensandbox: -"]);
  assert.deepEqual(remoteStatuses, [
    "opensandbox: starting…",
    "opensandbox: remote ✓",
  ]);

  await remote.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    ui: {
      select: async (_title, actions) => {
        assert.ok(actions.includes("OpenSandbox session running"));
        assert.equal(actions.includes("Start session"), false);
        assert.equal(actions.includes("End session"), false);
        return undefined;
      },
    },
  });

  const entriesBeforeTree = remote.entries.length;
  await remote.handlers.get("session_tree")(
    { type: "session_tree", newLeafId: "older", oldLeafId: "current" },
    sessionContext([], "remote-session", remoteStatuses),
  );
  assert.equal(starts, 1);
  assert.equal(remote.entries.length, entriesBeforeTree + 1);
  assert.deepEqual(remote.entries.at(-1), {
    customType: "pi-opensandbox-state",
    data: {
      active: true,
      sandboxId: "created-by-extension",
      owned: true,
    },
  });
});

test("local startup does not read configured Skills", async () => {
  const pi = fakePi();
  await createPiOpenSandboxExtension({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
    skills: [{ sourceDir: "/path/that/does/not/exist" }],
    sharedSkillRoot: "/tmp/pi-local-start/skills",
  })(pi.api);

  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    sessionContext(),
  );

  assert.deepEqual(pi.handlers.get("resources_discover")(), {});
  assert.deepEqual(pi.tools, []);
});

test("failed flag startup does not persist an active session", async (t) => {
  const originalStart = ActiveOpenSandbox.start;
  ActiveOpenSandbox.start = async () => {
    throw new Error("sandbox unavailable");
  };
  t.after(() => { ActiveOpenSandbox.start = originalStart; });

  const pi = fakePi({ opensandbox: true });
  await createPiOpenSandboxExtensionFromConfig(resolvePiOpenSandboxRuntimeConfig({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
  }))(pi.api);
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    sessionContext(),
  );

  assert.deepEqual(pi.entries, []);
});

test("resume restores the persisted sandbox while fork stays local", async (t) => {
  const originalStart = ActiveOpenSandbox.start;
  const restores = [];
  const active = activeSandbox({
    id: "persisted",
    renew: async () => {},
    pause: async () => {},
    close: async () => {},
  }, {
    startupMode: "resumed",
    owned: true,
  });
  ActiveOpenSandbox.start = async (_settings, _cwd, _sessionId, target) => {
    restores.push(target);
    return active;
  };
  t.after(() => { ActiveOpenSandbox.start = originalStart; });
  const config = resolvePiOpenSandboxRuntimeConfig({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
  });
  const branch = [{
    type: "custom",
    customType: "pi-opensandbox-state",
    data: { active: true, sandboxId: "persisted", owned: true },
  }];

  const resumed = fakePi();
  await createPiOpenSandboxExtensionFromConfig(config)(resumed.api);
  const statuses = [];
  resumed.handlers.get("session_start")(
    { type: "session_start", reason: "resume" },
    sessionContext(branch, "session", statuses),
  );
  assert.ok(resumed.tools.includes("bash"));
  const prompt = await resumed.handlers.get("before_agent_start")({
    systemPrompt: "Current working directory: /host",
  });
  assert.deepEqual(restores, [{ sandboxId: "persisted", owned: true }]);
  assert.match(prompt.systemPrompt, /OpenSandbox sandbox persisted/);
  assert.deepEqual(statuses, [
    "opensandbox: restoring…",
    "opensandbox: remote ✓",
  ]);
  await resumed.handlers.get("session_shutdown")();

  const forked = fakePi();
  await createPiOpenSandboxExtensionFromConfig(config)(forked.api);
  forked.handlers.get("session_start")(
    { type: "session_start", reason: "fork" },
    sessionContext(branch, "fork"),
  );
  assert.deepEqual(forked.tools, []);
  assert.deepEqual(forked.entries.at(-1), {
    customType: "pi-opensandbox-state",
    data: { active: false },
  });
  assert.equal(restores.length, 1);

  const malformed = fakePi();
  await createPiOpenSandboxExtensionFromConfig(config)(malformed.api);
  malformed.handlers.get("session_start")(
    { type: "session_start", reason: "resume" },
    sessionContext([...branch, {
      type: "custom",
      customType: "pi-opensandbox-state",
      data: { active: true, sandboxId: 42, owned: true },
    }], "malformed"),
  );
  assert.deepEqual(malformed.tools, []);
  assert.equal(restores.length, 1);
});

test("missing persisted sandbox is replaced and persisted", async (t) => {
  const originalConnect = Sandbox.connect;
  const originalResume = Sandbox.resume;
  const originalCreate = Sandbox.create;
  const createdDirectories = [];
  let creates = 0;
  const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
  Sandbox.connect = async () => {
    throw Object.assign(new Error("sandbox endpoint unavailable"), { statusCode: 503 });
  };
  Sandbox.resume = async () => { throw notFound; };
  Sandbox.create = async () => {
    creates += 1;
    return {
      id: "replacement",
      pause: async () => {},
      close: async () => {},
      files: {
        createDirectories: async (entries) => {
          createdDirectories.push(...entries.map((entry) => entry.path));
        },
      },
    };
  };
  t.after(() => {
    Sandbox.connect = originalConnect;
    Sandbox.resume = originalResume;
    Sandbox.create = originalCreate;
  });

  const pi = fakePi();
  await createPiOpenSandboxExtensionFromConfig(resolvePiOpenSandboxRuntimeConfig({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
  }))(pi.api);
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "resume" },
    sessionContext([{
      type: "custom",
      customType: "pi-opensandbox-state",
      data: { active: true, sandboxId: "expired", owned: true },
    }]),
  );

  assert.equal(creates, 1);
  assert.deepEqual(createdDirectories, ["/workspace"]);
  assert.deepEqual(pi.entries.at(-1), {
    customType: "pi-opensandbox-state",
    data: { active: true, sandboxId: "replacement", owned: true },
  });
  await pi.handlers.get("session_shutdown")();
});

test("remote sessions expose only selected Skills with sandbox paths", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-remote-skills-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, "lark-shared");
  const remoteRoot = "/tmp/pi-remote-session/skills";
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), `---
name: lark-shared
description: Use Lark safely
---
# Lark

Run the selected Lark workflow.
`);

  const originalStart = ActiveOpenSandbox.start;
  const remoteFiles = new Map();
  const active = activeSandbox({
    id: "remote-skills",
    renew: async () => {},
    pause: async () => {},
    close: async () => {},
    commands: {
      run: async (_command, _options, handlers) => {
        handlers.onInit({ id: "skill-activation" });
        return { exitCode: 0 };
      },
      interrupt: async () => {},
    },
    files: {
      createDirectories: async () => {},
      getFileInfo: async () => ({}),
      writeFiles: async (entries) => {
        for (const entry of entries) remoteFiles.set(entry.path, Buffer.from(entry.data));
      },
    },
  }, {
    readableResourceRoots: [remoteRoot],
  });
  ActiveOpenSandbox.start = async () => active;
  t.after(() => { ActiveOpenSandbox.start = originalStart; });

  const pi = fakePi();
  await createPiOpenSandboxExtension({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
    skills: [{ name: "lark-shared", sourceDir: source }],
    sharedSkillRoot: remoteRoot,
    verifyUploadedSkills: false,
  })(pi.api);
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "resume" },
    sessionContext([{
      type: "custom",
      customType: "pi-opensandbox-state",
      data: { active: true },
    }]),
  );
  const discovered = pi.handlers.get("resources_discover")();
  assert.equal(discovered.skillPaths.length, 1);
  assert.match(discovered.skillPaths[0], /lark-shared-[a-f0-9]{16}\/SKILL\.md$/);
  assert.equal(discovered.skillPaths[0].startsWith(remoteRoot), false);
  const skillNotifications = [];
  await pi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    ui: {
      select: async (_title, actions) => {
        assert.ok(actions.includes("Skills"));
        assert.ok(actions.includes("OpenSandbox session running"));
        assert.equal(actions.includes("Status"), false);
        assert.equal(actions.includes("Start session"), false);
        assert.equal(actions.includes("End session"), false);
        return "Skills";
      },
      notify: (message) => skillNotifications.push(message),
    },
  });
  assert.deepEqual(pi.commands, ["opensandbox"]);
  assert.match(skillNotifications[0], /^1 files, \d+ bytes\nlark-shared [a-f0-9]{12} /);

  const localSkills = [{
    name: "local-only",
    description: "Must not be exposed remotely",
    filePath: "/host/skills/local-only/SKILL.md",
    baseDir: "/host/skills/local-only",
    sourceInfo: createSyntheticSourceInfo("/host/skills/local-only/SKILL.md", {
      source: "user",
      scope: "user",
    }),
    disableModelInvocation: false,
  }];
  const prompt = await pi.handlers.get("before_agent_start")({
    systemPrompt: `System${formatSkillsForPrompt(localSkills)}\nCurrent working directory: /host\n`,
    systemPromptOptions: {
      cwd: "/host",
      selectedTools: ["read", "bash"],
      skills: localSkills,
    },
  });
  assert.doesNotMatch(prompt.systemPrompt, /local-only|\/host\/skills/);
  assert.match(prompt.systemPrompt, /<name>lark-shared<\/name>/);
  assert.match(
    prompt.systemPrompt,
    /\/tmp\/pi-remote-session\/skills\/lark-shared\/SKILL\.md/,
  );

  const selected = await pi.handlers.get("input")(
    { type: "input", text: "/skill:lark-shared create a doc", source: "interactive" },
    sessionContext(),
  );
  assert.equal(selected.action, "transform");
  assert.doesNotMatch(selected.text, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(selected.text, /location="\/tmp\/pi-remote-session\/skills\//);
  assert.match(selected.text, /Run the selected Lark workflow/);
  assert.match(selected.text, /create a doc$/);

  const notifications = [];
  const unselected = await pi.handlers.get("input")(
    { type: "input", text: "/skill:local-only", source: "interactive" },
    {
      ...sessionContext(),
      ui: {
        notify: (message) => notifications.push(message),
        setStatus: () => {},
      },
    },
  );
  assert.deepEqual(unselected, { action: "handled" });
  assert.match(notifications[0], /not selected/);
});

test("restore failure blocks agent use and remains retryable without local switching", async (t) => {
  const originalStart = ActiveOpenSandbox.start;
  let starts = 0;
  ActiveOpenSandbox.start = async () => {
    starts += 1;
    throw new Error("sandbox unavailable");
  };
  t.after(() => { ActiveOpenSandbox.start = originalStart; });

  const pi = fakePi();
  await createPiOpenSandboxExtensionFromConfig(resolvePiOpenSandboxRuntimeConfig({
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
  }))(pi.api);
  const statuses = [];
  pi.handlers.get("session_start")(
    { type: "session_start", reason: "resume" },
    sessionContext([{
      type: "custom",
      customType: "pi-opensandbox-state",
      data: { active: true, sandboxId: "missing", owned: true },
    }], "session", statuses),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    pi.handlers.get("before_agent_start")({ systemPrompt: "Current working directory: /host" }),
    /restore failed.*sandbox unavailable/,
  );

  let menu;
  await pi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    ui: {
      select: async (_title, actions) => {
        menu = actions;
        return undefined;
      },
      notify: () => {},
    },
  });
  assert.ok(menu.includes("Retry OpenSandbox"));
  assert.equal(menu.includes("Use local"), false);
  assert.equal(menu.includes("Start session"), false);
  assert.equal(menu.includes("End session"), false);
  assert.equal(starts, 1);
  assert.deepEqual(statuses, [
    "opensandbox: restoring…",
    "opensandbox: failed",
  ]);

  await pi.handlers.get("session_shutdown")();
  pi.handlers.get("session_start")(
    { type: "session_start", reason: "new" },
    sessionContext([], "new-session"),
  );
  const localPrompt = await pi.handlers.get("before_agent_start")({
    systemPrompt: "Current working directory: /host",
  });
  assert.equal(localPrompt, undefined);
});

test("session startup is deduplicated and remote operations await it", async () => {
  let resolveReady;
  let starts = 0;
  const active = activeSandbox({
    id: "pending",
    renew: async () => {},
    pause: async () => {},
    close: async () => {},
    commands: {
      run: async () => ({ exitCode: 0 }),
    },
  });
  const session = new SandboxSession({
    hostWorkspaceRoot: process.cwd(),
    startSandbox: async () => {
      starts += 1;
      return active;
    },
    onReady: async () => new Promise((resolve) => { resolveReady = resolve; }),
  });
  const first = session.startSandbox({ timeoutSeconds: 3600 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = session.startSandbox({ timeoutSeconds: 3600 });
  const bash = createBashOperations(() => session.requireActiveSandbox());
  const operation = bash.exec("true", process.cwd(), {});
  assert.equal(starts, 1);
  resolveReady();
  assert.equal(await first, active);
  assert.equal(await second, active);
  assert.deepEqual(await operation, { exitCode: 0 });
  await session.shutdown();
});

test("resumed ownership survives startup mode and controls release behavior", async () => {
  let killCalls = 0;
  let closeCalls = 0;
  const owned = activeSandbox({
    id: "owned-resumed",
    renew: async () => {},
    kill: async () => { killCalls += 1; },
    close: async () => { closeCalls += 1; },
  }, {
    startupMode: "resumed",
    owned: true,
  });
  const ownedSession = new SandboxSession({
    hostWorkspaceRoot: process.cwd(),
    startSandbox: async () => owned,
  });
  await ownedSession.startSandbox({ timeoutSeconds: 3600 });
  await ownedSession.deactivate();
  assert.equal(killCalls, 1);

  const external = activeSandbox({
    id: "external",
    renew: async () => {},
    kill: async () => { killCalls += 1; },
    close: async () => { closeCalls += 1; },
  }, {
    startupMode: "connected",
    owned: false,
  });
  const externalSession = new SandboxSession({
    hostWorkspaceRoot: process.cwd(),
    startSandbox: async () => external,
  });
  await externalSession.startSandbox({ timeoutSeconds: 3600 });
  await externalSession.deactivate();
  assert.equal(killCalls, 1);
  assert.equal(closeCalls, 2);
});

test("validates extension options at creation", () => {
  const sandboxConfig = { domain: "sandbox.example.test", image: "test" };

  assert.throws(
    () => createPiOpenSandboxExtension({ sandboxConfig, skills: [{ sourceDir: "." }] }),
    /skills and sharedSkillRoot must be configured together/,
  );
  assert.throws(
    () => createPiOpenSandboxExtension({
      sandboxConfig,
      skills: [{ sourceDir: "." }],
      sharedSkillRoot: "/tmp/task/skills",
      skillSyncLimits: { maxFiles: 0 },
    }),
    />0/,
  );
  assert.throws(
    () => createPiOpenSandboxExtension({
      sandboxConfig,
      createSandbox: async () => undefined,
    }),
    /Unrecognized key.*createSandbox/,
  );
});

test("materialized Skill cache repairs modified and extra files", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-skill-cache-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, "source");
  const root = join(temp, "skills");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# Stable\n");
  await writeFile(join(source, "run.sh"), "#!/bin/sh\n");
  await chmod(join(source, "run.sh"), 0o755);

  const limits = {
    maxFileBytes: 8 * 1024 * 1024,
    maxFiles: 10_000,
    maxTotalBytes: 128 * 1024 * 1024,
  };
  const [first] = await materializeSkills([{ sourceDir: source }], root, limits);
  const target = first.hostDir;
  await writeFile(join(target, "SKILL.md"), "# Corrupt\n");
  await writeFile(join(target, "extra.txt"), "unexpected");

  await Promise.all([
    materializeSkills([{ sourceDir: source }], root, limits),
    materializeSkills([{ sourceDir: source }], root, limits),
  ]);

  assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "# Stable\n");
  await assert.rejects(lstat(join(target, "extra.txt")), { code: "ENOENT" });
  assert.equal((await lstat(join(target, "run.sh"))).mode & 0o777, 0o755);
});

test("uploads Skills in batches and verifies remote content", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-skill-upload-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, "source");
  const localRoot = join(temp, "cache");
  const remoteRoot = "/tmp/pi-upload-test/skills";
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# Upload\n");
  await writeFile(join(source, "run.sh"), "#!/bin/sh\n");
  await chmod(join(source, "run.sh"), 0o755);
  for (let index = 0; index < 39; index += 1) {
    await writeFile(join(source, `file-${index}.txt`), String(index));
  }

  const remoteSandbox = remoteSkillSandbox(remoteRoot);
  const skillSyncLimits = {
    maxFileBytes: 8 * 1024 * 1024,
    maxFiles: 10_000,
    maxTotalBytes: 128 * 1024 * 1024,
  };
  const skills = await materializeSkills(
    [{ sourceDir: source }],
    localRoot,
    skillSyncLimits,
  );
  const active = activeSandbox(remoteSandbox.sandbox, {
    readableResourceRoots: [remoteRoot],
  });
  const report = await uploadSkills(active, skills, remoteRoot, skillSyncLimits, true);

  assert.equal(remoteSandbox.remote.size, 42);
  assert.equal(remoteSandbox.writeCalls(), 3);
  assert.equal(remoteSandbox.limitedReads(), 0);
  assert.equal(report.skills[0].skillFile, "/tmp/pi-upload-test/skills/source/SKILL.md");
  assert.equal(report.skills[0].skillFile.startsWith(localRoot), false);
  assert.equal(remoteSandbox.remoteModes.get(`${remoteRoot}/source/SKILL.md`), 644);
  assert.equal(remoteSandbox.remoteModes.get(`${remoteRoot}/source/run.sh`), 755);
  assert.equal(remoteSandbox.remoteModes.get(`${remoteRoot}/.pi-skills-manifest.json`), 600);
  const manifest = JSON.parse(
    remoteSandbox.remote.get(`${remoteRoot}/.pi-skills-manifest.json`).toString(),
  );
  assert.equal(manifest.skills.source.digest, skills[0].digest);
});

test("retries transient server errors while uploading Skills", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-skill-upload-retry-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, "source");
  const remoteRoot = "/tmp/pi-upload-retry/skills";
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# Retry\n");

  const limits = {
    maxFileBytes: 8 * 1024 * 1024,
    maxFiles: 10_000,
    maxTotalBytes: 128 * 1024 * 1024,
  };
  const remoteSandbox = remoteSkillSandbox(remoteRoot);
  remoteSandbox.failUploads(1);
  const skills = await materializeSkills(
    [{ sourceDir: source }],
    join(temp, "cache"),
    limits,
  );

  await uploadSkills(
    activeSandbox(remoteSandbox.sandbox, {
      readableResourceRoots: [remoteRoot],
    }),
    skills,
    remoteRoot,
    limits,
    true,
  );

  assert.equal(remoteSandbox.writeCalls(), 3);
  assert.equal(
    remoteSandbox.remote.get(`${remoteRoot}/source/SKILL.md`).toString(),
    "# Retry\n",
  );

  const unavailableSandbox = remoteSkillSandbox(remoteRoot);
  unavailableSandbox.failUploads(3);
  await assert.rejects(
    uploadSkills(
      activeSandbox(unavailableSandbox.sandbox, {
        readableResourceRoots: [remoteRoot],
      }),
      skills,
      remoteRoot,
      limits,
      true,
    ),
    /Upload failed \(status=500\)/,
  );
  assert.equal(unavailableSandbox.writeCalls(), 3);
});

test("replaces the remote Skill set only after activation succeeds", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-skill-replace-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const firstSource = join(temp, "first");
  const secondSource = join(temp, "second");
  const localRoot = join(temp, "cache");
  const remoteRoot = "/tmp/pi-replace-test/skills";
  await mkdir(firstSource);
  await mkdir(secondSource);
  await writeFile(join(firstSource, "SKILL.md"), "# First v1\n");
  await writeFile(join(secondSource, "SKILL.md"), "# Second\n");
  const limits = {
    maxFileBytes: 8 * 1024 * 1024,
    maxFiles: 10_000,
    maxTotalBytes: 128 * 1024 * 1024,
  };
  const remoteSandbox = remoteSkillSandbox(remoteRoot);
  remoteSandbox.remote.set(`${remoteRoot}/user-note.txt`, Buffer.from("keep me"));
  const active = activeSandbox(remoteSandbox.sandbox, {
    readableResourceRoots: [remoteRoot],
  });

  const initial = await materializeSkills(
    [{ sourceDir: firstSource }, { sourceDir: secondSource }],
    localRoot,
    limits,
  );
  await uploadSkills(active, initial, remoteRoot, limits, true);
  assert.deepEqual(
    [...remoteSandbox.remote.keys()].sort(),
    [
      `${remoteRoot}/.pi-skills-manifest.json`,
      `${remoteRoot}/first/SKILL.md`,
      `${remoteRoot}/second/SKILL.md`,
      `${remoteRoot}/user-note.txt`,
    ],
  );

  await writeFile(join(firstSource, "SKILL.md"), "# First v2\n");
  const updated = await materializeSkills(
    [{ sourceDir: firstSource }],
    localRoot,
    limits,
  );
  await uploadSkills(active, updated, remoteRoot, limits, true);
  assert.equal(
    remoteSandbox.remote.get(`${remoteRoot}/first/SKILL.md`).toString(),
    "# First v2\n",
  );
  assert.equal(remoteSandbox.remote.has(`${remoteRoot}/second/SKILL.md`), false);
  assert.equal(
    remoteSandbox.remote.get(`${remoteRoot}/user-note.txt`).toString(),
    "keep me",
  );
  assert.doesNotMatch(remoteSandbox.activationCommands.at(-1), /for entry in/);
  assert.match(remoteSandbox.activationCommands.at(-1), /\.absent-first/);
  const stableSnapshot = new Map(remoteSandbox.remote);

  await writeFile(join(firstSource, "SKILL.md"), "# First v3\n");
  const failed = await materializeSkills(
    [{ sourceDir: firstSource }],
    localRoot,
    limits,
  );
  remoteSandbox.failNextActivation();
  await assert.rejects(
    uploadSkills(active, failed, remoteRoot, limits, true),
    /Remote Skill activation failed/,
  );
  assert.deepEqual(remoteSandbox.remote, stableSnapshot);
});

test("routine shutdown pauses owned sandboxes and retries failed release", async () => {
  let pauseCalls = 0;
  let closeCalls = 0;
  const sandbox = {
    id: "retry",
    renew: async () => {},
    pause: async () => {
      pauseCalls += 1;
      if (pauseCalls === 1) throw new Error("temporary failure");
    },
    close: async () => { closeCalls += 1; },
  };
  const active = activeSandbox(sandbox);
  const session = new SandboxSession({
    hostWorkspaceRoot: process.cwd(),
    startSandbox: async () => active,
  });
  await session.startSandbox({ timeoutSeconds: 3600 });

  await assert.rejects(session.shutdown(), /temporary failure/);
  assert.equal(session.getActiveSandbox(), active);
  assert.equal(closeCalls, 0);
  await session.shutdown();
  assert.equal(session.getActiveSandbox(), null);
  assert.equal(pauseCalls, 2);
  assert.equal(closeCalls, 1);
});

test("remote bash forwards Pi environment and the complete output stream", async (t) => {
  const previousSession = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = "session";
  t.after(() => {
    if (previousSession === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = previousSession;
  });
  let runOptions;
  const chunks = [];
  const sandbox = {
    commands: {
      run: async (_command, options, handlers) => {
        runOptions = options;
        handlers.onInit({ id: "exec" });
        handlers.onStdout({ text: "1234567890" });
        return { exitCode: 0 };
      },
      interrupt: async () => {},
    },
  };
  const operations = createBashOperations(async () => activeSandbox(sandbox));
  await operations.exec("env", process.cwd(), {
    onData: (data) => chunks.push(data),
  });

  assert.deepEqual(runOptions.envs, {
    AI_AGENT: "pi",
    PI_CODING_AGENT: "true",
    PI_SESSION_ID: "session",
  });
  assert.equal(Buffer.concat(chunks).toString(), "1234567890");
});

test("find uses the sandbox filesystem and grep builds a valid shell script", async () => {
  const commands = [];
  const searches = [];
  const outputs = ["src/search.ts:1:needle\n"];
  const active = activeSandbox({
    files: {
      getFileInfo: async (paths) => ({ [paths[0]]: { path: paths[0] } }),
      search: async (entry) => {
        searches.push(entry);
        return [
          { path: "/workspace/src/search.ts" },
          { path: "/workspace/node_modules/package/index.js" },
        ];
      },
    },
    commands: {
      run: async (command, _options, handlers) => {
        commands.push(command);
        handlers.onInit({ id: "search" });
        handlers.onStdout({ text: outputs.shift() });
        return { exitCode: 0 };
      },
      interrupt: async () => {},
    },
  });

  const find = createFindOperations(async () => active);
  assert.equal(await find.exists(process.cwd()), true);
  assert.deepEqual(
    await find.glob("**/*.ts", process.cwd(), {
      ignore: ["**/node_modules/**"],
      limit: 10,
    }),
    ["src/search.ts"],
  );
  await runRemoteGrep(active, { pattern: "needle", glob: "*.ts" });

  assert.deepEqual(searches, [{ path: "/workspace", pattern: "**/*.ts" }]);
  for (const command of commands) {
    assert.equal(spawnSync("sh", ["-n"], { input: command }).status, 0);
  }
});

test("failed-start cleanup remains observable", async () => {
  const messages = [];
  const original = console.error;
  console.error = (message) => messages.push(String(message));
  try {
    await activeSandbox({
      id: "cleanup",
      kill: async () => { throw new Error("kill failed"); },
      close: async () => { throw new Error("close failed"); },
    }).cleanupAfterStartFailure();
  } finally {
    console.error = original;
  }
  assert.ok(messages.some((message) => message.includes("sandbox.cleanup.kill.error")));
  assert.ok(messages.some((message) => message.includes("sandbox.cleanup.close.error")));
});

test("error logging redacts credentials in JSON and header formats", () => {
  const details = describeOpenSandboxError(
    new Error('request {"apiKey":"secret","password":"hidden"} Authorization: Bearer token'),
  );

  assert.equal(
    details.errorMessage,
    'request {"apiKey":"[REDACTED]","password":"[REDACTED]"} '
      + "Authorization: Bearer [REDACTED]",
  );
});

test("accepts compatibility null and empty network policy values", () => {
  const config = resolveOpenSandboxSettings({
    domain: "sandbox.example.test",
    image: "test",
    networkPolicy: { defaultAction: "" },
    volumes: [{
      name: "data",
      mountPath: "/data",
      ossfs: {
        bucket: "bucket",
        endpoint: "endpoint",
        accessKeyId: "id",
        accessKeySecret: "secret",
        options: null,
      },
    }],
  });
  assert.deepEqual(config.networkPolicy, {});
  assert.equal("options" in config.volumes[0].ossfs, false);
});

test("rejects symbolic links in selected Skills", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-skill-link-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, "source");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# Test\n");
  await symlink(join(source, "SKILL.md"), join(source, "linked.md"));

  await assert.rejects(
    materializeSkills(
      [{ sourceDir: source }],
      join(temp, "skills"),
      {
        maxFileBytes: 8 * 1024 * 1024,
        maxFiles: 10_000,
        maxTotalBytes: 128 * 1024 * 1024,
      },
    ),
    /symbolic link/,
  );
});

test("rejects the reserved remote Skill manifest name", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-skill-name-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, "source");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# Test\n");

  await assert.rejects(
    materializeSkills(
      [{ name: ".pi-skills-manifest.json", sourceDir: source }],
      join(temp, "skills"),
      {
        maxFileBytes: 8 * 1024 * 1024,
        maxFiles: 10_000,
        maxTotalBytes: 128 * 1024 * 1024,
      },
    ),
    /Invalid Skill name/,
  );
});
