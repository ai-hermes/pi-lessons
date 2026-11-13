import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const imageIndex = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: ["amd64", "arm64"].map((architecture, i) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${String(i).repeat(64)}`,
    size: 100,
    platform: { os: "linux", architecture },
  })),
};

function inspectIndex(input) {
  return spawnSync("python3", ["-B", "deploy/inspect_index.py"], {
    cwd: new URL(".", import.meta.url),
    input,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("image index digest covers the exact bytes of both platforms", () => {
  for (const mediaType of [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ]) {
    const input = `${JSON.stringify({ ...imageIndex, mediaType }, null, 2)}\n`;
    const result = inspectIndex(input);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `sha256:${createHash("sha256").update(input).digest("hex")}`);
  }
});

for (const [name, change] of [
  ["single-platform image", index => { index.mediaType = "application/vnd.oci.image.manifest.v1+json"; }],
  ["missing arm64", index => { index.manifests.pop(); }],
  ["duplicate amd64", index => { index.manifests[1].platform.architecture = "amd64"; }],
  ["unsupported architecture", index => { index.manifests[1].platform.architecture = "arm"; }],
  ["wrong OS", index => { index.manifests[1].platform.os = "windows"; }],
  ["missing platform", index => { delete index.manifests[1].platform; }],
  ["invalid digest", index => { index.manifests[1].digest = "sha256:invalid"; }],
  ["invalid descriptor size", index => { index.manifests[1].size = 0; }],
  ["extra attestation", index => { index.manifests.push({ platform: { os: "unknown", architecture: "unknown" } }); }],
]) {
  test(`image index validation rejects ${name}`, () => {
    const index = structuredClone(imageIndex);
    change(index);
    const result = inspectIndex(JSON.stringify(index));
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  });
}

test("image index validation rejects malformed JSON", () => {
  const result = inspectIndex("{");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("OCI archive copy retains both platforms and the index digest", {
  skip: spawnSync("skopeo", ["--version"]).status !== 0,
}, () => {
  const temp = mkdtempSync(join(tmpdir(), "image-mcp-oci-"));
  try {
    const source = join(temp, "source");
    mkdirSync(join(source, "blobs", "sha256"), { recursive: true });
    const blob = (value, mediaType) => {
      const raw = JSON.stringify(value);
      const hash = createHash("sha256").update(raw).digest("hex");
      writeFileSync(join(source, "blobs", "sha256", hash), raw);
      return { mediaType, digest: `sha256:${hash}`, size: Buffer.byteLength(raw) };
    };
    const index = {
      ...imageIndex,
      manifests: ["amd64", "arm64"].map(architecture => ({
        ...blob({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config: blob({
            architecture, os: "linux", rootfs: { type: "layers", diff_ids: [] },
          }, "application/vnd.oci.image.config.v1+json"),
          layers: [],
        }, "application/vnd.oci.image.manifest.v1+json"),
        platform: { os: "linux", architecture },
      })),
    };
    const descriptor = blob(index, imageIndex.mediaType);
    writeFileSync(join(source, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
    writeFileSync(join(source, "index.json"), JSON.stringify({
      schemaVersion: 2, manifests: [descriptor],
    }));
    const archive = join(temp, "image.tar");
    const commands = [
      ["tar", ["-cf", archive, "-C", source, "."]],
      ["skopeo", ["copy", "--all", "--preserve-digests",
        `oci-archive:${archive}`, `oci:${join(temp, "copied")}:image`]],
    ];
    for (const [command, args] of commands) {
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const image of [`oci-archive:${archive}`, `oci:${join(temp, "copied")}:image`]) {
      const result = spawnSync("skopeo", ["inspect", "--raw", image], {
        encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const inspected = inspectIndex(result.stdout);
      assert.equal(inspected.status, 0, inspected.stderr);
      assert.equal(inspected.stdout.trim(), descriptor.digest);
      for (const arch of ["amd64", "arm64"]) {
        const platform = spawnSync("skopeo", ["inspect", "--override-os", "linux",
          "--override-arch", arch, "--format", "{{.Os}}/{{.Architecture}}", image], {
          encoding: "utf8", timeout: 10_000,
        });
        assert.equal(platform.status, 0, platform.stderr);
        assert.equal(platform.stdout.trim(), `linux/${arch}`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CI and release keep the complete multi-architecture index", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/agentgateway-image-mcp.yml", import.meta.url), "utf8");
  const release = readFileSync(new URL("./deploy/release.sh", import.meta.url), "utf8");
  const publish = readFileSync(new URL("./deploy/publish.sh", import.meta.url), "utf8");
  assert.match(workflow, /--platform linux\/amd64,linux\/arm64/);
  assert.match(workflow, /--output "type=oci,dest=\$archive"/);
  assert.match(workflow, /for arch in amd64 arm64/);
  for (const script of [workflow, release]) {
    assert.match(script, /agentgateway-image-mcp-multiarch/);
    assert.match(script, /inspect_index\.py/);
  }
  assert.ok(release.includes('"$bundle/config/inspect_index.py"'));
  assert.match(release, /for file in .*config\/inspect_index\.py/);
  assert.match(publish, /skopeo copy --all .*--preserve-digests/);
  assert.doesNotMatch(publish, /--override-arch/);
  assert.ok(publish.includes('export MCP_IMAGE="${image%:*}@$digest"'));
});

test("MCP deployment uses default scheduling without fixed node variables", () => {
  const resources = readFileSync(new URL("./deploy/resources.yaml", import.meta.url), "utf8");
  const deployment = resources.split(/^---$/m).find(block =>
    block.includes("kind: Deployment"));
  assert.ok(deployment);
  assert.doesNotMatch(deployment, /^\s+(affinity|nodeSelector|nodeName):/m);
  for (const path of ["deploy/resources.yaml", "deploy/publish.sh", "deploy/BUNDLE.md"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /MCP_NODE_\d+/);
  }
  const publish = readFileSync(new URL("./deploy/publish.sh", import.meta.url), "utf8");
  assert.ok(publish.includes("envsubst '${MCP_IMAGE}'"));
});

test("MCP policy uses default Bearer extraction and clears incoming credentials", () => {
  const resources = readFileSync(new URL("./deploy/resources.yaml", import.meta.url), "utf8");
  const policy = resources.split(/^---$/m).find(block =>
    block.includes("name: ark-image-mcp-client-auth"));
  assert.ok(policy);
  assert.match(policy, /mode: Strict/);
  assert.match(policy, /secretRef:\s+name: agentgateway-client-keys/);
  assert.doesNotMatch(policy, /^\s+location:/m);
  assert.match(policy, /remove: \[x-api-key, authorization\]/);
});

for (const [name, env, expected] of [
  ["rejects plaintext endpoints", {
    AGENTGATEWAY_MCP_URL: "http://example.com/mcp/images",
    AGENTGATEWAY_API_KEY: "test-only",
  }, /https:/],
  ["rejects missing credentials", {
    AGENTGATEWAY_MCP_URL: "https://example.com/mcp/images",
  }, /AGENTGATEWAY_API_KEY is required/],
]) {
  test(`HTTP check ${name} before making requests`, () => {
    const result = spawnSync(process.execPath, [
      "--import", "data:text/javascript,globalThis.fetch=()=>{throw new Error('NETWORK_REQUEST_ATTEMPTED')}",
      "check.mjs",
    ], {
      cwd: new URL(".", import.meta.url),
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /NETWORK_REQUEST_ATTEMPTED/);
  });
}
