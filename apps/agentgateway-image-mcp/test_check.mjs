import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /GHCR_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/agentgateway-image-mcp/);
  assert.match(workflow, /org\.opencontainers\.image\.source=/);
  assert.match(workflow, /skopeo copy --all .*--preserve-digests/);
  assert.match(release, /git archive .*source\.tar/);
  assert.match(release, /if \[\[ "\$\{2:-\}" == "--upload" \]\]/);
  assert.doesNotMatch(release, /images\.manifest|deploy\/\.download|kubectl/);
  assert.match(publish, /skopeo copy --all .*--preserve-digests/);
  assert.ok(publish.includes('"docker://$source" "docker://$image"'));
  assert.doesNotMatch(publish, /bdpan|oci-archive|images\.lock/);
  assert.doesNotMatch(publish, /--override-arch/);
  assert.ok(publish.includes('export MCP_IMAGE="${image%:*}@$digest"'));
});

function withDeployTools(run) {
  const temp = mkdtempSync(join(tmpdir(), "image-mcp-deploy-"));
  const config = join(temp, "apps", "agentgateway-image-mcp", "deploy");
  cpSync(new URL("./deploy", import.meta.url), config, { recursive: true });
  const bin = join(temp, "bin");
  mkdirSync(bin);
  const index = join(temp, "index.json");
  const raw = JSON.stringify(imageIndex);
  writeFileSync(index, raw);
  const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const mock = `#!/usr/bin/env bash
set -eu
tool="\${0##*/}"
printf '%s %s\\n' "$tool" "$*" >> "$TASK_LOG"
case "$tool" in
  skopeo)
    case "$1" in
      login) cat >/dev/null ;;
      copy) ;;
      inspect)
        if [[ "$*" == *'registry.test/'* && ! -e "$TASK_TEMP/copied" ]]; then
          if [[ "\${TASK_CONFLICT:-}" == 1 ]]; then printf '{}'; else exit 1; fi
        else cat "$TASK_INDEX"; fi ;;
    esac
    if [[ "$1" == copy ]]; then touch "$TASK_TEMP/copied"; fi ;;
  kubectl)
    if [[ "$*" == *'get deployment'* ]]; then
      if [[ "\${TASK_EXISTING:-}" == 1 ]]; then
        printf '{"metadata":{"name":"ark-image-mcp","uid":"old"},"spec":{},"status":{}}'
      fi
    elif [[ "$*" == *'rollout status'* && "\${TASK_FAIL_ROLLOUT:-}" == 1 && ! -e "$TASK_TEMP/failed" ]]; then
      touch "$TASK_TEMP/failed"; exit 1
    fi ;;
  git)
    if [[ "$*" == *'--show-toplevel'* ]]; then printf '%s\\n' "$TASK_TEMP"
    elif [[ "$*" == 'rev-parse HEAD' ]]; then printf '%s\\n' "$TASK_COMMIT"
    elif [[ "$1" == archive ]]; then
      for arg in "$@"; do
        if [[ "$arg" == --output=* ]]; then printf 'source snapshot' > "\${arg#--output=}"; fi
      done
    fi ;;
  gh)
    if [[ "$*" == 'run view '* ]]; then
      printf '{"conclusion":"success","headBranch":"main","headSha":"%s","workflowName":"agentgateway-image-mcp CI"}' "$TASK_COMMIT"
    elif [[ "$*" == 'run download '* ]]; then
      while [[ "$1" != -D ]]; do shift; done
      cp "$TASK_FIXTURES/"* "$2/"
    fi ;;
  bdpan)
    [[ "\${TASK_UPLOAD:-}" == 1 ]] || { echo 'NETDISK_NOT_REQUESTED' >&2; exit 1; }
    if [[ "$1" == ls && ! -e "$TASK_TEMP/uploaded" ]]; then exit 1; fi
    if [[ "$1" == cp && "$*" != *--dryrun* ]]; then touch "$TASK_TEMP/uploaded"; fi ;;
esac
`;
  for (const tool of ["skopeo", "kubectl", "git", "gh", "bdpan"]) {
    writeFileSync(join(bin, tool), mock, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TASK_TEMP: temp, TASK_INDEX: index, TASK_LOG: join(temp, "commands.log"),
    TASK_COMMIT: "a".repeat(40),
    KUBECONFIG: join(temp, "unused-kubeconfig"), REGISTRY_USERNAME: "test-only",
    REGISTRY_IMAGE: "registry.test/images/mcp:v1",
  };
  try { run({ temp, config, digest, env }); }
  finally { rmSync(temp, { recursive: true, force: true }); }
}

for (const [name, overrides, status] of [
  ["first deployment", {}, 0],
  ["existing deployment", { TASK_EXISTING: "1" }, 0],
  ["conflicting destination tag", { TASK_CONFLICT: "1" }, 1],
  ["failed first rollout", { TASK_FAIL_ROLLOUT: "1" }, 1],
  ["failed existing rollout", { TASK_EXISTING: "1", TASK_FAIL_ROLLOUT: "1" }, 1],
]) {
  test(`optional VKE procedure handles ${name} without Netdisk`, () => withDeployTools(({ config, env, digest }) => {
    const result = spawnSync("bash", [join(config, "publish.sh"), "ghcr.io/ai-hermes/agentgateway-image-mcp:v1"], {
      env: { ...env, ...overrides }, input: "test-only\n", encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    const log = readFileSync(env.TASK_LOG, "utf8");
    assert.doesNotMatch(log, /bdpan|gh run|oci-archive/);
    if (overrides.TASK_CONFLICT) {
      assert.doesNotMatch(log, /skopeo copy|kubectl apply -f/);
    } else {
      assert.ok(log.includes(`docker://ghcr.io/ai-hermes/agentgateway-image-mcp@${digest}`));
      assert.match(log, /--all .*--preserve-digests/);
      assert.match(log, /kubectl apply --dry-run=server/);
      const restores = log.split("\n").filter(line => /kubectl apply -f .*previous-deployment.json/.test(line));
      assert.equal(restores.length, overrides.TASK_EXISTING && overrides.TASK_FAIL_ROLLOUT ? 1 : 0);
    }
  }));
}

for (const upload of [false, true]) {
  test(`reproducibility archive ${upload ? "optionally uploads once" : "does not require Netdisk"} without deployment`, () => withDeployTools(({ temp, config, env, digest }) => {
    const fixtures = join(temp, "fixtures");
    mkdirSync(fixtures);
    const archive = `agentgateway-image-mcp-v1.0.0-${"a".repeat(12)}-multiarch.tar`;
    writeFileSync(join(fixtures, archive), "test-only OCI archive");
    writeFileSync(join(fixtures, "image.txt"), `ghcr.io/ai-hermes/agentgateway-image-mcp@${digest}\n`);
    writeFileSync(join(fixtures, "SHA256SUMS"), [archive, "image.txt"].map(file =>
      `${createHash("sha256").update(readFileSync(join(fixtures, file))).digest("hex")}  ${file}\n`).join(""));
    const result = spawnSync("bash", [join(config, "release.sh"), "123", ...(upload ? ["--upload"] : [])], {
      env: { ...env, TASK_FIXTURES: fixtures, TASK_UPLOAD: upload ? "1" : "" }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(env.TASK_LOG, "utf8");
    assert.doesNotMatch(log, /kubectl|skopeo (login|copy)/);
    if (upload) {
      const copies = log.split("\n").filter(line => /^bdpan cp /.test(line));
      assert.equal(copies.length, 2);
      assert.match(copies[0], /--recursive --dryrun --no-overwrite/);
      assert.match(copies[1], /--recursive --no-overwrite/);
      assert.doesNotMatch(log, /images\.manifest|deploy\/\.download/);
    } else {
      assert.doesNotMatch(log, /bdpan/);
    }
    const bundle = join(temp, "deploy", "agentgateway-image-mcp", `v1.0.0-${"a".repeat(12)}`);
    assert.match(readFileSync(join(bundle, "images.lock"), "utf8"), /ghcr.io\/ai-hermes\/agentgateway-image-mcp/);
    assert.equal(readFileSync(join(bundle, "source.tar"), "utf8"), "source snapshot");
    const verified = spawnSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], {
      cwd: bundle, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(verified.status, 0, verified.stderr);
  }));
}

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
