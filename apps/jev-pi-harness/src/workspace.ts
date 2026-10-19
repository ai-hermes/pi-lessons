/**
 * The agent gets Pi's built-in read / edit / write / bash tools, rooted at the workspace.
 * Pi's tools accept any path, so the boundary is enforced by the Gate, in code, with `Workspace.describe`.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

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
			return { inside: true, abs, exists: true, kind: statSync(abs).isDirectory() ? "dir" : "file", createdThisRun: this.createdThisRun.has(abs) };
		} catch (err) {
			return { inside: false, violation: (err as Error).message };
		}
	}
}

export function createTools(ws: Workspace): AgentTool<any>[] {
	return [createReadTool(ws.root), createEditTool(ws.root), createWriteTool(ws.root), createBashTool(ws.root)];
}
