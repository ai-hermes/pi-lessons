import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { redact, redactText } from "../src/decision-log.ts";
import { createWorkspaceTools, Workspace, WorkspaceViolation } from "../src/workspace.ts";

function makeWorkspace() {
	const base = mkdtempSync(join(tmpdir(), "jph-test-"));
	const root = join(base, "ws");
	mkdirSync(join(root, "notes"), { recursive: true });
	mkdirSync(join(base, "outside"));
	writeFileSync(join(root, "notes", "a.md"), "hello");
	writeFileSync(join(root, ".env"), "TOKEN=x");
	writeFileSync(join(base, "outside", "secret.txt"), "secret");
	symlinkSync(join(base, "outside"), join(root, "link"));
	return { base, ws: new Workspace(root) };
}

describe("Workspace.resolve", () => {
	it("accepts paths inside the workspace", () => {
		const { ws } = makeWorkspace();
		assert.equal(ws.resolve("notes/a.md"), join(ws.root, "notes", "a.md"));
		assert.equal(ws.resolve("notes/new.md"), join(ws.root, "notes", "new.md"));
	});

	it("rejects parent traversal and absolute paths outside", () => {
		const { ws, base } = makeWorkspace();
		assert.throws(() => ws.resolve("../outside/secret.txt"), WorkspaceViolation);
		assert.throws(() => ws.resolve(join(base, "outside", "secret.txt")), WorkspaceViolation);
		assert.throws(() => ws.resolve("notes/../../outside"), WorkspaceViolation);
	});

	it("rejects symlink escapes, including not-yet-existing children", () => {
		const { ws } = makeWorkspace();
		assert.throws(() => ws.resolve("link/secret.txt"), /symlink/);
		assert.throws(() => ws.resolve("link/new-file.txt"), /symlink/);
	});

	it("rejects protected entries", () => {
		const { ws } = makeWorkspace();
		assert.throws(() => ws.resolve(".env"), /protected/);
		assert.throws(() => ws.resolve(".git/config"), /protected/);
	});

	it("describes targets for the Gate", () => {
		const { ws } = makeWorkspace();
		assert.deepEqual(ws.describe("notes/a.md"), { inside: true, exists: true, kind: "file", createdThisRun: false });
		assert.equal(ws.describe("../x").inside, false);
	});
});

describe("workspace tools", () => {
	it("tracks files created by the run and refuses to delete non-empty directories", async () => {
		const { ws } = makeWorkspace();
		const tools = Object.fromEntries(createWorkspaceTools(ws).map((t) => [t.name, t]));
		await tools.write_file!.execute("1", { path: "notes/new.md", content: "x" });
		assert.equal(ws.describe("notes/new.md").createdThisRun, true);
		await assert.rejects(tools.delete_path!.execute("2", { path: "notes" }), /non-empty/);
		await assert.rejects(tools.delete_path!.execute("3", { path: "." }), /workspace root/);
	});

	it("hides protected entries from listings", async () => {
		const { ws } = makeWorkspace();
		const list = createWorkspaceTools(ws).find((t) => t.name === "list_dir")!;
		const res = await list.execute("1", { path: "." });
		const text = (res.content[0] as { text: string }).text;
		assert.doesNotMatch(text, /\.env/);
	});
});

describe("redaction", () => {
	it("masks e-mails, keys, bearer tokens and credential assignments", () => {
		const out = redactText("mail lin.wei@example.com key sk-abcdefghijklmnop Bearer abc.def api_key=hunter2 password: p4ss");
		assert.doesNotMatch(out, /lin\.wei|abcdefghijklmnop|abc\.def|hunter2|p4ss/);
		assert.match(out, /\[email\]/);
	});

	it("truncates long strings and recurses into objects", () => {
		const out = redact({ content: "x".repeat(1_000), nested: ["a@b.co"] }, 50) as { content: string; nested: string[] };
		assert.ok(out.content.length < 80);
		assert.match(out.content, /\+950 chars/);
		assert.deepEqual(out.nested, ["[email]"]);
	});
});
