import { Sandbox } from "@alibaba-group/opensandbox";
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), ".env"), quiet: true });

export function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}; set it in .env.`);
  }
  return value;
}

export const opensandboxConnectionOptions = {
  domain: requiredEnv("OPENSANDBOX_DOMAIN"),
  apiKey: requiredEnv("OPENSANDBOX_API_KEY"),
};

export function sleepN(n: number) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, n * 1_000);
  });
}

export async function probe(sandbox: Sandbox, url: string) {
  const result = await sandbox.commands.run(`curl -sSI --max-time 10 ${url}`);
  const output = [...result.logs.stdout, ...result.logs.stderr]
    .map(({ text }) => text)
    .join("")
    .trim()
    .split("\n")[0];

  console.log(`${url}: exit=${result.exitCode ?? "unknown"} ${output}`);
  return result.exitCode === 0;
}
