import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension, { createPiOpenSandboxExtension } from "../dist/index.js";
import { materializeSkills, uploadSkills } from "../dist/skills.js";
import { resolveOpenSandboxSettings } from "../dist/sandbox/config.js";
import { createBashOperations } from "../dist/sandbox/tool-operations.js";
import { ActiveOpenSandbox } from "../dist/sandbox/client.js";
import { createFindOperations, runRemoteGrep } from "../dist/sandbox/search.js";
import { SandboxSession } from "../dist/sandbox/session.js";

function fakePi() {
  const handlers = new Map();
  const commands = [];
  const commandHandlers = new Map();
  const tools = [];
  return {
    handlers,
    commands,
    commandHandlers,
    tools,
    api: {
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name, command) => {
        commands.push(name);
        commandHandlers.set(name, command.handler);
      },
      registerTool: (tool) => tools.push(tool.name),
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
    ...overrides,
  });
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
      getFileInfo: async () => ({ "/workspace/large.txt": { size: 5 } }),
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

test("package manifest exposes a loadable Pi extension", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@ai.hermes/pi-opensandbox");
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.keywords.includes("pi-extension"));
  assert.equal(pkg.publishConfig.access, "public");
  await lstat(new URL("../src/index.ts", import.meta.url));
  await lstat(new URL(`../${pkg.main}`, import.meta.url));
});

test("Pi loads the source package without build artifacts", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-opensandbox-layout-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const packageDir = join(temp, "extension");
  await mkdir(packageDir);
  await cp(new URL("../src", import.meta.url), join(packageDir, "src"), { recursive: true });
  await cp(new URL("../package.json", import.meta.url), join(packageDir, "package.json"));
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(packageDir, "node_modules"), "dir");
  await assert.rejects(lstat(join(packageDir, "dist")), { code: "ENOENT" });

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
  assert.equal(extensions[0].resolvedPath, join(packageDir, "src/index.ts"));
  assert.ok(extensions[0].commands.has("opensandbox"));
  assert.equal(extensions[0].commands.size, 1);
  assert.ok(extensions[0].tools.has("bash"));
  assert.ok(extensions[0].handlers.has("session_start"));
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
  assert.deepEqual(pi.tools.sort(), [
    "bash",
    "edit",
    "find",
    "grep",
    "ls",
    "opensandbox_port_url",
    "read",
    "write",
  ]);
  assert.deepEqual([...pi.handlers.keys()].sort(), [
    "before_agent_start",
    "session_shutdown",
    "session_start",
    "user_bash",
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
  assert.deepEqual([...pi.handlers.keys()], []);
});

test("default Pi entry enables remote tools from user configuration", async (t) => {
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
  assert.ok(pi.tools.includes("bash"));
  assert.ok(pi.handlers.has("session_start"));
  assert.ok(pi.handlers.has("session_shutdown"));
});

test("configuration command masks the key, writes user config, and reloads", async (t) => {
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
  const inputs = ["sandbox.example.test", "image"];
  await pi.commandHandlers.get("opensandbox")("", {
    hasUI: true,
    mode: "tui",
    reload: async () => { reloads += 1; },
    ui: {
      select: async () => "Configure and enable",
      input: async () => inputs.shift(),
      notify: (message) => notifications.push(message),
      custom: async (factory) => new Promise((resolve) => {
        const component = factory(
          undefined,
          undefined,
          { matches: (data, action) => action === "tui.select.confirm" && data === "\n" },
          resolve,
        );
        component.handleInput("super-secret");
        assert.equal(component.render().join("\n").includes("super-secret"), false);
        component.handleInput("\n");
      }),
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

  const options = {
    sandboxConfig: { domain: "sandbox.example.test", image: "test" },
    skills: [{ sourceDir: source }],
    sharedSkillRoot: root,
  };
  const first = fakePi();
  await createPiOpenSandboxExtension(options)(first.api);
  const [{ path: skillFile }] = first.handlers.get("resources_discover")().skillPaths
    .map((path) => ({ path }));
  const target = join(skillFile, "..");
  await writeFile(join(target, "SKILL.md"), "# Corrupt\n");
  await writeFile(join(target, "extra.txt"), "unexpected");

  await Promise.all([
    createPiOpenSandboxExtension(options)(fakePi().api),
    createPiOpenSandboxExtension(options)(fakePi().api),
  ]);

  assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "# Stable\n");
  await assert.rejects(lstat(join(target, "extra.txt")), { code: "ENOENT" });
  assert.equal((await lstat(join(target, "run.sh"))).mode & 0o777, 0o755);
});

test("uploads Skills in batches and verifies remote content", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-skill-upload-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, "source");
  const root = join(temp, "skills");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# Upload\n");
  for (let index = 0; index < 39; index += 1) {
    await writeFile(join(source, `file-${index}.txt`), String(index));
  }

  const remote = new Map();
  let writeCalls = 0;
  const sandbox = {
    id: "upload",
    renew: async () => {},
    kill: async () => {},
    close: async () => {},
    files: {
      createDirectories: async () => {},
      writeFiles: async (entries) => {
        writeCalls += 1;
        for (const entry of entries) remote.set(entry.path, Buffer.from(entry.data));
      },
      getFileInfo: async (paths) => Object.fromEntries(
        paths.filter((path) => remote.has(path)).map((path) => [path, { size: remote.get(path).byteLength }]),
      ),
      readBytesStream: async function* (path) {
        yield remote.get(path);
      },
    },
  };
  const skillSyncLimits = {
    maxFileBytes: 8 * 1024 * 1024,
    maxFiles: 10_000,
    maxTotalBytes: 128 * 1024 * 1024,
  };
  const skills = await materializeSkills(
    [{ sourceDir: source }],
    root,
    skillSyncLimits,
  );
  const active = activeSandbox(sandbox, {
    readableResourceRoots: [root],
  });
  await uploadSkills(active, skills, root, skillSyncLimits, true);

  assert.equal(remote.size, 40);
  assert.equal(writeCalls, 2);
});

test("shutdown retains state when release fails and retries", async () => {
  let killCalls = 0;
  const sandbox = {
    id: "retry",
    renew: async () => {},
    kill: async () => {
      killCalls += 1;
      if (killCalls === 1) throw new Error("temporary failure");
    },
    close: async () => {},
  };
  const active = activeSandbox(sandbox);
  const session = new SandboxSession({
    hostWorkspaceRoot: process.cwd(),
    policy: { onSessionShutdown: "kill" },
    startSandbox: async () => active,
  });
  await session.startSandbox({ timeoutSeconds: 3600 });

  await assert.rejects(session.shutdown(), /temporary failure/);
  assert.equal(session.getActiveSandbox(), active);
  await session.shutdown();
  assert.equal(session.getActiveSandbox(), null);
  assert.equal(killCalls, 2);
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
  const operations = createBashOperations(() => activeSandbox(sandbox));
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

  const find = createFindOperations(() => active);
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
    createPiOpenSandboxExtension({
      sandboxConfig: { domain: "sandbox.example.test", image: "test" },
      skills: [{ sourceDir: source }],
      sharedSkillRoot: join(temp, "skills"),
    })(fakePi().api),
    /symbolic link/,
  );
});
