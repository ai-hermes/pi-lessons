import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { SandboxManager } from "@alibaba-group/opensandbox";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(packageDir, "src", "index.ts");
const configured = JSON.parse(requiredEnvironment("PI_OPENSANDBOX_CONFIG"));
const apiKey = requiredEnvironment("OPENSANDBOX_API_KEY");
const domain = configured.sandboxConfig?.domain;
const image = configured.sandboxConfig?.image;
assert.equal(typeof domain, "string", "PI_OPENSANDBOX_CONFIG requires sandboxConfig.domain");
assert.equal(typeof image, "string", "PI_OPENSANDBOX_CONFIG requires sandboxConfig.image");

const agentDir = await mkdtemp(join(tmpdir(), "pi-opensandbox-e2e-"));
const sessionId = randomUUID();
const sessionDir = join(agentDir, "sessions");
const sessionFile = join(sessionDir, `e2e_${sessionId}.jsonl`);
let sandboxId;

try {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: packageDir,
  })}\n`);
  await runPiCommand("Enable OpenSandbox");

  const configPath = join(agentDir, "extensions", "opensandbox.json");
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(stored.enabled, true);
  assert.equal(stored.sandboxConfig.domain, domain);
  assert.equal(stored.sandboxConfig.image, image);
  assert.equal(stored.sandboxConfig.apiKey, apiKey);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  const status = await runPiCommand("Status");
  assert.match(status, /Enabled: yes/);
  assert.match(status, /Source: user configuration/);
  assert.match(status, new RegExp(`Domain: ${escapeRegExp(normalizedDomain(domain))}`));
  assert.match(status, new RegExp(`Image: ${escapeRegExp(image)}`));
  assert.doesNotMatch(status, /API key:/);
  assert.doesNotMatch(status, new RegExp(escapeRegExp(apiKey)));
  assert.match(status, /Mode: local/);
  assert.match(status, /Current sandbox: not active/);

  const activation = await runPiCommand("OpenSandbox session running", true);
  sandboxId = activation.match(/OpenSandbox created: (\S+)/)?.[1];
  assert.ok(sandboxId, "Pi did not create an OpenSandbox sandbox");
  assert.deepEqual(await readRemoteSessionState(), {
    active: true,
    sandboxId,
    owned: true,
  });
  await assertSandboxPreserved(sandboxId);

  console.log("OpenSandbox E2E passed: local config, dedicated remote session, pause, and cleanup");
} finally {
  if (sandboxId) await requestSandboxCleanup(sandboxId);
  await rm(agentDir, { recursive: true, force: true });
}

async function runPiCommand(action, opensandbox = false) {
  const childEnvironment = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete childEnvironment.PI_OPENSANDBOX_CONFIG;
  delete childEnvironment.PI_OPENSANDBOX_CONFIG_FILE;

  const child = spawn("pi", [
    "--mode", "rpc",
    "--session-id", sessionId,
    "--session-dir", sessionDir,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--extension", extensionPath,
    "--approve",
    ...(opensandbox ? ["--opensandbox"] : []),
  ], {
    cwd: packageDir,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const notifications = [];
  let commandFinished = false;
  let actionFinished = false;
  let finishScheduled = false;
  const finishIfReady = () => {
    if (!commandFinished || !actionFinished || finishScheduled) return;
    finishScheduled = true;
    setTimeout(() => child.stdin.end(), 500);
  };
  const lines = createInterface({ input: child.stdout });
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Pi RPC timed out during ${action}`)), 120_000);
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.type === "extension_ui_request") {
        if (message.method === "select") {
          assert.ok(
            message.options.includes(action),
            `Action ${action} is unavailable; options: ${message.options.join(", ")}`,
          );
          respond(child, message.id, { value: action });
        } else if (message.method === "input") {
          respond(child, message.id, {
            value: message.title === "OpenSandbox domain"
              ? domain
              : message.title === "OpenSandbox image" ? image : apiKey,
          });
        } else if (message.method === "notify") {
          notifications.push(message.message);
          actionFinished = notificationCompletes(action, message.message);
          finishIfReady();
        }
      }

      if (message.type === "response" && message.id === "e2e-command") {
        commandFinished = true;
        finishIfReady();
      }
      if (message.type === "extension_error") {
        child.kill();
        reject(new Error(redact(`Pi extension failed: ${message.error}`)));
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !commandFinished) {
        reject(new Error(redact(`Pi RPC failed (${code}): ${stderr.join("")}`)));
        return;
      }
      resolve();
    });
  });

  child.stdin.write(`${JSON.stringify({
    id: "e2e-command",
    type: "prompt",
    message: "/opensandbox",
  })}\n`);
  await completed;
  return notifications.join("\n");
}

async function readLatestSessionState(file) {
  const entries = (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === "pi-opensandbox-state") {
      return entry.data;
    }
  }
  return undefined;
}

async function readRemoteSessionState() {
  for (const file of await readdir(sessionDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const state = await readLatestSessionState(join(sessionDir, file));
    if (state?.active === true && typeof state.sandboxId === "string") return state;
  }
  return undefined;
}

function notificationCompletes(action, message) {
  if (action === "Enable OpenSandbox") return message?.startsWith("OpenSandbox configured.");
  if (action === "Status") return message?.includes("Source: user configuration");
  if (action === "OpenSandbox session running") {
    return message?.includes("Current sandbox:");
  }
  return false;
}

async function assertSandboxPreserved(sandboxId) {
  const manager = SandboxManager.create({
    connectionConfig: {
      domain,
      protocol: configured.sandboxConfig.protocol,
      apiKey,
    },
  });
  try {
    const info = await manager.getSandboxInfo(sandboxId);
    assert.ok(
      info.status.state === "Paused" || info.status.state === "Running",
      `Sandbox ${sandboxId} was not preserved after Pi shutdown: ${info.status.state}`,
    );
  } finally {
    await manager.close();
  }
}

async function requestSandboxCleanup(sandboxId) {
  const manager = SandboxManager.create({
    connectionConfig: {
      domain,
      protocol: configured.sandboxConfig.protocol,
      apiKey,
    },
  });
  try {
    await manager.killSandbox(sandboxId).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  } finally {
    await manager.close();
  }
}

function respond(child, id, response) {
  child.stdin.write(`${JSON.stringify({
    type: "extension_ui_response",
    id,
    ...response,
  })}\n`);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running the E2E test`);
  return value;
}

function normalizedDomain(value) {
  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
  return `${url.host}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNotFound(error) {
  const text = String(error).toLowerCase();
  return error?.statusCode === 404
    || error?.response?.status === 404
    || text.includes("404")
    || text.includes("not found");
}

function redact(value) {
  return value.replaceAll(apiKey, "[REDACTED]");
}
