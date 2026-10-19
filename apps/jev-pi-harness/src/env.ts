/** Loads apps/jev-pi-harness/.env once; variables already in the environment win. */
try {
	process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

export function env(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}
