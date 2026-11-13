#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const url = new URL(process.env.AGENTGATEWAY_MCP_URL);
if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error("Remote MCP connections require HTTPS.");
}
const key = execFileSync(
  "/usr/bin/security",
  ["find-generic-password", "-w", "-a", process.env.USER, "-s", "agentgateway-api-aii"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
if (!key) throw new Error("Missing Agentgateway API key in Keychain.");

const remote = new Client({ name: "agentgateway-images-local", version: "1.0.0" });
await remote.connect(new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${key}` } },
}));
const local = new Server(
  { name: "agentgateway-images", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
local.setRequestHandler(ListToolsRequestSchema, () => remote.listTools());
local.setRequestHandler(CallToolRequestSchema, request =>
  remote.callTool(request.params, undefined, { timeout: 210_000 }),
);
const transport = new StdioServerTransport();
transport.onclose = () => { void remote.close(); };
await local.connect(transport);
