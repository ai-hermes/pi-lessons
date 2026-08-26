import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function resolveExtension(packageName: string): string {
  try {
    return join(dirname(require.resolve(`${packageName}/package.json`)), "index.ts");
  } catch (error) {
    throw new Error(`Unable to resolve required Pi extension "${packageName}". Run pnpm install before starting the app.`, {
      cause: error,
    });
  }
}

export const PI_EXTENSION_PATHS = [
  resolveExtension("pi-web-access"),
];
