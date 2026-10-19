/**
 * pnpm --filter jev-pi-harness cases [<id>|all] [--fresh]
 *
 * Runs demo cases on a scratch copy of fixtures/workspace and appends every decision to decisions.jsonl.
 * --fresh empties decisions.jsonl first.
 */
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type DecisionRecord, DecisionLog } from "@/decision-log.ts";
import { env } from "@/env.ts";
import { type HarnessEvent, runHarness } from "@/harness.ts";
import { createTypeSafeJev } from "@/jev/client.ts";
import type { Approver } from "@/stages/gate.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const which = args.find((a) => !a.startsWith("--")) ?? "all";
const logFile = env("DECISION_LOG", new URL("../decisions.jsonl", import.meta.url).pathname);

const selected = which === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.id.startsWith(which));
if (selected.length === 0) {
	console.error(`Unknown case "${which}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
	process.exit(1);
}
const missing = ["TYPESAFE_API_KEY", "HTTPS_PROXY", "KIMI_API_KEY"].filter((name) => !env(name));
if (missing.length > 0) {
	console.error(`❌ Missing ${missing.join(", ")}: copy .env.example to .env and fill them in.`);
	process.exit(1);
}
if (fresh) rmSync(logFile, { force: true });

/** Asks on the terminal; no TTY or no answer within 60 s means "no". */
const askHuman: Approver = async (subject, signals) => {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(`\n⚠️  Allow ${subject}? ${JSON.stringify(signals)} [y/N] `, { signal: AbortSignal.timeout(60_000) });
		return /^y(es)?$/i.test(answer.trim());
	} catch {
		return false;
	} finally {
		rl.close();
	}
};

const ICON: Record<string, string> = { allow: "✅", block: "⛔", fast: "⚡", powerful: "🧠", accept: "✅", retry: "🔁", "give-up": "🏳️" };

function printDecision(r: DecisionRecord): void {
	const signals = r.signals ? JSON.stringify(r.signals, (_, v) => (typeof v === "number" ? Number(v.toFixed(2)) : v)) : "";
	const why = r.fallback ? `FALLBACK ${r.fallback} (${r.error})` : (r.reason ?? "");
	console.log(`\n  ${ICON[r.verdict] ?? "•"} [${r.stage}] ${r.verdict} ${r.subject.replace(/\s+/g, " ").slice(0, 70)}\n       ${[signals, why].filter(Boolean).join(" · ")}`);
}

function printEvent(e: HarnessEvent): void {
	if (e.type === "attempt") console.log(`\n── attempt ${e.attempt} · ${e.tier} (${e.model}) ──`);
	if (e.type === "text") process.stdout.write(e.delta);
	if (e.type === "tool") console.log(`\n  🔧 ${e.name} ${JSON.stringify(e.args).slice(0, 120)}`);
	if (e.type === "tool-result") console.log(`  ${e.isError ? "✗" : "↳"} ${e.text.split("\n")[0]?.slice(0, 120)}`);
}

async function runCase(s: Scenario): Promise<void> {
	console.log(`\n\n████ ${s.id} · ${s.title}\n👀 ${s.watch}\n🙋 ${s.request}`);

	// Port 9 (discard) has nothing listening: the real client fails with a connection error
	const jev = createTypeSafeJev(s.jevDown ? { baseURL: "http://127.0.0.1:9" } : {});
	const log = new DecisionLog(`${s.id}-${randomUUID().slice(0, 8)}`, logFile, printDecision);
	// Cases delete and overwrite files, so they run on a throwaway copy
	const workspaceDir = mkdtempSync(join(tmpdir(), "jev-pi-harness-"));
	cpSync(new URL("../fixtures/workspace", import.meta.url).pathname, workspaceDir, { recursive: true });

	const r = await runHarness({ request: s.request, workspaceDir, jev, approver: askHuman, log, onEvent: printEvent });
	console.log(`\n\n━━ tier=${r.tier} attempts=${r.attempts} verified=${r.verification.verified} (${r.verification.reason}) decisions=${r.decisions.length}\n${r.answer}`);
}

for (const s of selected) {
	await runCase(s);
}
console.log(`\n📝 Decisions appended to ${logFile}`);
