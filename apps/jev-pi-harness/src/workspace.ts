/**
 * File tools for the agent, with the hard boundaries enforced in code.
 *
 * Whatever Jev says, these tools refuse paths that resolve outside the workspace (including through
 * symlinks) and never touch protected entries such as `.env` or `.git`. Probabilistic judgement sits on
 * top of these rules, never instead of them.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export class WorkspaceViolation extends Error {}

const PROTECTED = [/^\.env(\..*)?$/, /^\.git$/, /^\.ssh$/, /^node_modules$/];
const MAX_READ_CHARS = 20_000;

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class Workspace {
	readonly root: string;
	/** Files this run created; overwriting or deleting them is not "destroying someone else's data" */
	readonly createdThisRun = new Set<string>();

	constructor(root: string) {
		this.root = realpathSync(root);
	}

	/** Resolves `input` to an absolute path inside the workspace or throws WorkspaceViolation. */
	resolve(input: string): string {
		if (typeof input !== "string" || input.length === 0) throw new WorkspaceViolation("path must be a non-empty string");
		const target = resolve(this.root, input);
		if (!isInside(this.root, target)) throw new WorkspaceViolation(`"${input}" resolves outside the workspace`);

		// Symlinks: the closest existing ancestor must still resolve inside the workspace
		let probe = target;
		while (!existsSync(probe) && probe !== this.root) probe = dirname(probe);
		if (!isInside(this.root, realpathSync(probe))) throw new WorkspaceViolation(`"${input}" escapes the workspace through a symlink`);

		const rel = relative(this.root, target);
		if (rel.split(sep).some((part) => PROTECTED.some((re) => re.test(part)))) throw new WorkspaceViolation(`"${input}" is a protected path`);
		return target;
	}

	/** Code-computed facts about a path argument, handed to the Gate alongside the raw arguments. */
	describe(input: string): { inside: boolean; exists?: boolean; kind?: "file" | "dir"; createdThisRun?: boolean; violation?: string } {
		try {
			const abs = this.resolve(input);
			if (!existsSync(abs)) return { inside: true, exists: false };
			return { inside: true, exists: true, kind: statSync(abs).isDirectory() ? "dir" : "file", createdThisRun: this.createdThisRun.has(abs) };
		} catch (err) {
			return { inside: false, violation: (err as Error).message };
		}
	}

	rel(abs: string): string {
		return relative(this.root, abs) || ".";
	}
}

export interface HarnessTool extends AgentTool {
	/** Read-only tools skip Jev: code already knows they cannot destroy anything */
	readOnly: boolean;
	/** Argument names that carry workspace paths, checked by code before Gate asks Jev */
	pathArgs: string[];
}

function text(content: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: content }], details };
}

export function createWorkspaceTools(ws: Workspace): HarnessTool[] {
	const pathParam = Type.String({ description: "Path relative to the workspace root" });

	return [
		{
			name: "list_dir",
			label: "List directory",
			description: "List entries of a directory in the workspace.",
			parameters: Type.Object({ path: Type.Optional(pathParam) }),
			readOnly: true,
			pathArgs: ["path"],
			async execute(_id, params) {
				const abs = ws.resolve((params as { path?: string }).path ?? ".");
				const entries = readdirSync(abs, { withFileTypes: true })
					.filter((e) => !PROTECTED.some((re) => re.test(e.name)))
					.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
				return text(entries.join("\n") || "(empty)");
			},
		},
		{
			name: "read_file",
			label: "Read file",
			description: "Read a UTF-8 text file from the workspace.",
			parameters: Type.Object({ path: pathParam }),
			readOnly: true,
			pathArgs: ["path"],
			async execute(_id, params) {
				const abs = ws.resolve((params as { path: string }).path);
				const content = readFileSync(abs, "utf8");
				return text(content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n…(truncated)` : content);
			},
		},
		{
			name: "write_file",
			label: "Write file",
			description: "Create a file, or replace the whole content of an existing file.",
			parameters: Type.Object({ path: pathParam, content: Type.String() }),
			readOnly: false,
			pathArgs: ["path"],
			async execute(_id, params) {
				const { path, content } = params as { path: string; content: string };
				const abs = ws.resolve(path);
				const existed = existsSync(abs);
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, content);
				if (!existed) ws.createdThisRun.add(abs);
				return text(`${existed ? "Overwrote" : "Created"} ${ws.rel(abs)} (${content.length} chars)`);
			},
		},
		{
			name: "delete_path",
			label: "Delete path",
			description: "Delete a file or an empty directory from the workspace.",
			parameters: Type.Object({ path: pathParam }),
			readOnly: false,
			pathArgs: ["path"],
			async execute(_id, params) {
				const abs = ws.resolve((params as { path: string }).path);
				if (abs === ws.root) throw new WorkspaceViolation("refusing to delete the workspace root");
				const stat = lstatSync(abs);
				if (stat.isDirectory()) {
					if (readdirSync(abs).length > 0) throw new WorkspaceViolation("refusing to delete a non-empty directory");
					rmdirSync(abs);
				} else {
					rmSync(abs);
				}
				ws.createdThisRun.delete(abs);
				return text(`Deleted ${ws.rel(abs)}`);
			},
		},
	];
}
