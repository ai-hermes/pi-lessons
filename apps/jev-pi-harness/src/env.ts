/** Loads apps/jev-pi-harness/.env once; variables already in the environment win. */
try {
	process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

/** process.env[name] if set and non-blank, otherwise `fallback` (which may itself be undefined) */
export function env(name: string): string | undefined;
export function env(name: string, fallback: string): string;
export function env(name: string, fallback?: string): string | undefined;
export function env(name: string, fallback?: string): string | undefined {
	return process.env[name]?.trim() || fallback;
}
