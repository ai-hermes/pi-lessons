/**
 * File tools for the agent. The workspace boundary is enforced here, in code, whatever Jev says.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

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

	/** Absolute path inside the workspace, or throws. Symlinks are checked through the nearest existing ancestor. */
	resolve(input: string): string {
		const target = resolve(this.root, input);
		let probe = target;
		while (!existsSync(probe)) probe = dirname(probe);
		if (!isInside(this.root, target) || !isInside(this.root, realpathSync(probe))) throw new Error(`"${input}" is outside the workspace`);
		return target;
	}

	/** Code-computed facts about a path argument, handed to the Gate */
	describe(input: string) {
		try {
			const abs = this.resolve(input);
			if (!existsSync(abs)) return { inside: true, exists: false };
			return { inside: true, exists: true, kind: statSync(abs).isDirectory() ? "dir" : "file", createdThisRun: this.createdThisRun.has(abs) };
		} catch (err) {
			return { inside: false, violation: (err as Error).message };
		}
	}
}

export interface HarnessTool extends AgentTool {
	/** Read-only tools skip Jev */
	readOnly: boolean;
	/** Arguments holding workspace paths, checked by code before Jev is asked */
	pathArgs: string[];
}

const text = (content: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: content }], details: {} });

export function createWorkspaceTools(ws: Workspace): HarnessTool[] {
	const path = Type.String({ description: "Path relative to the workspace root" });
	return [
		{
			name: "read_file",
			label: "Read file",
			description: "Read a UTF-8 text file from the workspace.",
			parameters: Type.Object({ path }),
			readOnly: true,
			pathArgs: ["path"],
			async execute(_id, params) {
				return text(readFileSync(ws.resolve((params as { path: string }).path), "utf8"));
			},
		},
		{
			name: "write_file",
			label: "Write file",
			description: "Create a file, or replace the whole content of an existing file.",
			parameters: Type.Object({ path, content: Type.String() }),
			readOnly: false,
			pathArgs: ["path"],
			async execute(_id, params) {
				const { path: p, content } = params as { path: string; content: string };
				const abs = ws.resolve(p);
				const existed = existsSync(abs);
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, content);
				if (!existed) ws.createdThisRun.add(abs);
				return text(`${existed ? "Overwrote" : "Created"} ${p}`);
			},
		},
		{
			name: "delete_path",
			label: "Delete file",
			description: "Delete a file from the workspace.",
			parameters: Type.Object({ path }),
			readOnly: false,
			pathArgs: ["path"],
			async execute(_id, params) {
				const p = (params as { path: string }).path;
				rmSync(ws.resolve(p));
				return text(`Deleted ${p}`);
			},
		},
	];
}
