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
