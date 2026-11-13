import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const endpoint = new URL(process.env.AGENTGATEWAY_MCP_URL);
assert.equal(endpoint.protocol, "https:");
const base = endpoint.origin;
const key = execFileSync("/usr/bin/security", [
  "find-generic-password", "-w", "-a", process.env.USER, "-s", "agentgateway-api-aii",
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const init = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "1" } },
};
for (const headers of [{}, { Authorization: "Bearer invalid-test-key" }]) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(init),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 401);
  await response.body?.cancel();
}
console.log("MCP missing/invalid credentials: 401");

const transports = [
  new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }),
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./local-bridge.mjs", import.meta.url).pathname],
    env: { ...process.env },
  }),
];
for (const [index, transport] of transports.entries()) {
  const client = new Client({ name: "image-mcp-check", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ["generate_image"]);
    assert.match(tools[0].description, /charges/);
    const invalid = await client.callTool({ name: "generate_image", arguments: { prompt: "" } });
    assert.equal(invalid.isError, true);
    console.log(`${index ? "Local bridge" : "Public MCP"}: initialize, tools/list, invalid tools/call passed`);
  } finally {
    await client.close();
  }
}

for (const [path, expected] of [["/echo", 200], ["/ui/", 401], ["/v1/models", 401]]) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, expected);
  await response.body?.cancel();
}
const media = await fetch(`${base}/v1/images/generations`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
  // Alias transformation requires model; omit prompt so Ark cannot generate.
  body: JSON.stringify({ model: "doubao-seedream-5.0-pro" }),
  signal: AbortSignal.timeout(30_000),
});
const mediaBody = await media.text();
assert.equal(media.status, 400);
assert.match(mediaBody, /MissingParameter/);
console.log("Existing routes passed; no images generated.");
