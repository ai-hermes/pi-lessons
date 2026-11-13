import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the bridge rejects plaintext remote endpoints before reading credentials", () => {
  const result = spawnSync(process.execPath, ["local-bridge.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, AGENTGATEWAY_MCP_URL: "http://example.com/mcp/images" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Remote MCP connections require HTTPS/);
});
