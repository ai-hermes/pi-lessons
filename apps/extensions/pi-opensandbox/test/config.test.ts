import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadInstalledPiOpenSandboxConfig,
  loadPiOpenSandboxConfig,
  readStoredPiOpenSandboxConfig,
  resolvePiOpenSandboxRuntimeConfig,
  writeStoredPiOpenSandboxConfig,
} from "../dist/config.js";
import { resolveOpenSandboxSettings } from "../dist/sandbox/config.js";

test("resolves the complete extension configuration", () => {
  const config = resolvePiOpenSandboxRuntimeConfig(
    {
      sandboxConfig: { image: "image" },
      verifyUploadedSkills: false,
    },
    {
      OPENSANDBOX_DOMAIN: "https://sandbox.example.test/api",
      OPENSANDBOX_API_KEY: "secret",
    },
  );

  assert.equal(config.sandboxSettings.domain, "sandbox.example.test/api");
  assert.equal(config.sandboxSettings.protocol, "https");
  assert.equal(config.sandboxSettings.apiKey, "secret");
  assert.equal(config.verifyUploadedSkills, false);
  assert.deepEqual(config.selectedSkills, []);
});

test("loads and validates inline extension configuration", async () => {
  const config = await loadPiOpenSandboxConfig({
    PI_OPENSANDBOX_CONFIG: JSON.stringify({
      sandboxConfig: { image: "image" },
    }),
    OPENSANDBOX_DOMAIN: "sandbox.example.test",
  });

  assert.equal(config.sandboxSettings.domain, "sandbox.example.test");
  assert.equal(config.sandboxSettings.image, "image");
  assert.equal(config.verifyUploadedSkills, true);

  await assert.rejects(
    loadPiOpenSandboxConfig({
      PI_OPENSANDBOX_CONFIG: "{}",
      PI_OPENSANDBOX_CONFIG_FILE: "/tmp/config.json",
    }),
    /Set only one/,
  );
  await assert.rejects(
    loadPiOpenSandboxConfig({ PI_OPENSANDBOX_CONFIG: "{" }),
    /not valid JSON/,
  );
});

test("loads optional user configuration and lets the environment override its key", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-opensandbox-config-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, "extensions", "opensandbox.json");

  assert.deepEqual(
    await loadInstalledPiOpenSandboxConfig({}, configPath),
    { enabled: false, source: "none" },
  );
  await writeStoredPiOpenSandboxConfig({
    enabled: true,
    options: {
      sandboxConfig: {
        apiKey: "stored-secret",
        domain: "sandbox.example.test",
        image: "image",
      },
    },
  }, configPath);

  const loaded = await loadInstalledPiOpenSandboxConfig({
    OPENSANDBOX_API_KEY: "environment-secret",
  }, configPath);
  assert.equal(loaded.runtime.sandboxSettings.apiKey, "environment-secret");
  assert.equal(loaded.options.sandboxConfig.apiKey, "stored-secret");
  assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, true);

  await writeStoredPiOpenSandboxConfig({
    enabled: false,
    options: loaded.options,
  }, configPath);
  assert.deepEqual(await readStoredPiOpenSandboxConfig(configPath), {
    enabled: false,
    options: loaded.options,
  });
  assert.equal((await loadInstalledPiOpenSandboxConfig({}, configPath)).enabled, false);
});

test("validates user configuration before writing it", async () => {
  await assert.rejects(
    writeStoredPiOpenSandboxConfig({ enabled: true }, "/tmp/unused-opensandbox.json"),
    /requires options/,
  );
});

test("normalizes standalone OpenSandbox configuration", () => {
  const config = resolveOpenSandboxSettings({
    domain: "https://sandbox.example.test/api/",
    image: "opensandbox/code-interpreter:v1.1.0",
    networkAllowlist: [],
    resourceRoots: ["/tmp/task/skills"],
  });

  assert.equal(config.domain, "sandbox.example.test/api");
  assert.equal(config.protocol, "https");
  assert.equal(config.useServerProxy, true);
  assert.equal(config.workspace, "/workspace");
  assert.equal(config.lifecycle.onSessionShutdown, "kill");
});

test("reads the demo environment names", (t) => {
  const previousDomain = process.env.OPENSANDBOX_DOMAIN;
  const previousApiKey = process.env.OPENSANDBOX_API_KEY;
  process.env.OPENSANDBOX_DOMAIN = "https://sandbox.example.test";
  process.env.OPENSANDBOX_API_KEY = "secret";
  t.after(() => {
    if (previousDomain === undefined) delete process.env.OPENSANDBOX_DOMAIN;
    else process.env.OPENSANDBOX_DOMAIN = previousDomain;
    if (previousApiKey === undefined) delete process.env.OPENSANDBOX_API_KEY;
    else process.env.OPENSANDBOX_API_KEY = previousApiKey;
  });

  const config = resolveOpenSandboxSettings({ image: "image" });
  assert.equal(config.domain, "sandbox.example.test");
  assert.equal(config.apiKey, "secret");
});

test("rejects ambiguous create configuration", () => {
  assert.throws(
    () => resolveOpenSandboxSettings({
      domain: "sandbox.example.test",
      image: "image",
      snapshotId: "snapshot",
    }),
    /exactly one of image or snapshotId/,
  );
});

test("rejects invalid configuration boundaries", () => {
  assert.throws(() => resolveOpenSandboxSettings(null));
  assert.throws(
    () => resolveOpenSandboxSettings({
      domain: "sandbox.example.test",
      image: "image",
      metadata: { "opensandbox.io/internal": "reserved" },
    }),
    /reserved opensandbox\.io/,
  );
  assert.throws(
    () => resolveOpenSandboxSettings({
      domain: "sandbox.example.test",
      image: "image",
      resourceRoots: ["/tmp/../skills"],
    }),
    /absolute POSIX paths without \. or \.\. segments/,
  );
  assert.throws(
    () => resolveOpenSandboxSettings({
      domain: "sandbox.example.test",
      image: "image",
      volumes: [{ name: "data", mountPath: "/data" }],
    }),
    /exactly one backend/,
  );
});

test("preserves supported nullable and empty compatibility values", () => {
  const config = resolveOpenSandboxSettings({
    domain: "sandbox.example.test",
    entrypoint: [],
    image: "image",
    volumes: [{
      name: "data",
      mountPath: "/data",
      pvc: {
        claimName: "claim",
        accessModes: null,
        storage: null,
        storageClass: null,
      },
    }],
  });

  assert.equal("entrypoint" in config, false);
  assert.deepEqual(config.volumes[0].pvc, {
    claimName: "claim",
    accessModes: null,
    storage: null,
    storageClass: null,
  });
});
