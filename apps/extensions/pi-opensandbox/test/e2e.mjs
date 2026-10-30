import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
const sandboxIds = [];

try {
  await runPiCommand("Configure and enable");

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
  assert.match(status, /API key: configured/);
  assert.match(status, /Current sandbox: \S+/);
  assert.match(status, /Workspace: \S+/);

  await assertSandboxesCleaned();
  console.log("OpenSandbox E2E passed: slash config, persisted reload, sandbox startup, and cleanup");
} finally {
  await rm(agentDir, { recursive: true, force: true });
}

async function runPiCommand(action) {
  const childEnvironment = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete childEnvironment.PI_OPENSANDBOX_CONFIG;
  delete childEnvironment.PI_OPENSANDBOX_CONFIG_FILE;

  const child = spawn("pi", [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--extension", extensionPath,
    "--approve",
  ], {
    cwd: packageDir,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  let status = "";
  let commandFinished = false;
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
          respond(child, message.id, { value: action });
        } else if (message.method === "input") {
          respond(child, message.id, {
            value: message.title === "OpenSandbox domain" ? domain : image,
          });
        } else if (message.method === "notify") {
          if (message.message?.startsWith("OpenSandbox created: ")) {
            sandboxIds.push(message.message.slice("OpenSandbox created: ".length));
          }
          if (message.message?.includes("Source: user configuration")) {
            status = message.message;
          }
        }
      }

      if (message.type === "response" && message.id === "e2e-command") {
        commandFinished = true;
        child.stdin.end();
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
  return status;
}

async function assertSandboxesCleaned() {
  assert.ok(sandboxIds.length > 0, "Pi did not create a sandbox from persisted user config");
  const manager = SandboxManager.create({
    connectionConfig: {
      domain,
      protocol: configured.sandboxConfig.protocol,
      apiKey,
    },
  });
  try {
    for (const sandboxId of new Set(sandboxIds)) {
      await assert.rejects(
        manager.getSandboxInfo(sandboxId),
        (error) => isNotFound(error),
        `Sandbox ${sandboxId} was not killed on Pi shutdown`,
      );
    }
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
