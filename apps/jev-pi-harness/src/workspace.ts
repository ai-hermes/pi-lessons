/**
 * Workspace boundary for Pi's built-in tools. The tools accept any path, so the Gate checks each
 * path argument here, in code, before the call runs.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const isInside = (root: string, target: string) => {
	const rel = relative(root, target);
	return !rel.startsWith("..") && !isAbsolute(rel);
};

export class Workspace {
	readonly root: string;
	/** Overwriting or deleting a file this run created is not "destroying someone else's data" */
	readonly createdThisRun = new Set<string>();

	constructor(root: string) {
		this.root = realpathSync(root);
	}

	/**
	 * Absolute path inside the workspace, or throws. Mirrors how Pi's tools read a path (`@` prefix stripped,
	 * `~` expanded, so rejected here). Symlinks are checked through the nearest existing ancestor.
	 */
	resolve(input: string): string {
		const path = input.replace(/^@/, "");
		if (path.startsWith("~")) throw new Error(`"${input}" is outside the workspace`);
		const target = resolve(this.root, path);
		let probe = target;
		while (!existsSync(probe)) probe = dirname(probe);
		if (!isInside(this.root, target) || !isInside(this.root, realpathSync(probe))) throw new Error(`"${input}" is outside the workspace`);
		return target;
	}

	/** Code-computed facts about a path argument, handed to the Gate */
	describe(input: string) {
		try {
			const abs = this.resolve(input);
			if (!existsSync(abs)) return { inside: true, abs, exists: false };
			return {
				inside: true,
				abs,
				exists: true,
				kind: statSync(abs).isDirectory() ? "dir" : "file",
				createdThisRun: this.createdThisRun.has(abs)
			};
		} catch (err) {
			return { inside: false, violation: (err as Error).message };
		}
	}
}
