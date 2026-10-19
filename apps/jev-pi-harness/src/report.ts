/** Console rendering shared by the CLI and the case runner. */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "./decision-log.ts";
import type { HarnessEvent, HarnessResult } from "./harness.ts";

export const FIXTURE_WORKSPACE = new URL("../fixtures/workspace", import.meta.url).pathname;

/** Cases may delete or overwrite files, so they always run on a throwaway copy of the fixture. */
export function scratchWorkspace(source = FIXTURE_WORKSPACE): string {
	const dir = mkdtempSync(join(tmpdir(), "jev-pi-harness-"));
	cpSync(source, dir, { recursive: true });
	return dir;
}

const ICON: Record<string, string> = { allow: "✅", ask: "🟡", block: "⛔", fast: "⚡", powerful: "🧠", accept: "✅", retry: "🔁", "give-up": "🏳️" };

export function formatDecision(r: DecisionRecord): string {
	const signals = r.signals
		? Object.entries(r.signals)
				.map(([k, v]) => `${k}=${v.toFixed(2)}`)
				.join(" ")
		: "";
	const why = r.fallback ? `FALLBACK ${r.fallback} (${r.error})` : (r.reason ?? "");
	return `  ${(ICON[r.verdict] ?? "•").padEnd(2)} [${r.stage}] ${r.verdict.padEnd(8)} ${r.subject.replace(/\s+/g, " ").slice(0, 70)}\n       ${[signals, why, `${r.latencyMs}ms`].filter(Boolean).join(" · ")}`;
}

export function printEvent(event: HarnessEvent): void {
	switch (event.type) {
		case "attempt":
			console.log(`\n── attempt ${event.attempt} · ${event.tier} tier (${event.model}) ──`);
			break;
		case "text":
			process.stdout.write(event.delta);
			break;
		case "tool":
			console.log(`\n  🔧 ${event.name} ${JSON.stringify(event.args).slice(0, 120)}`);
			break;
		case "tool-result":
			console.log(`  ${event.isError ? "✗" : "↳"} ${event.text.split("\n")[0]?.slice(0, 120) ?? ""}`);
			break;
	}
}

export function printDecision(record: DecisionRecord): void {
	console.log(`\n${formatDecision(record)}`);
}

export function printResult(result: HarnessResult): void {
	const v = result.verification;
	const totalMs = result.decisions.reduce((sum, d) => sum + d.latencyMs, 0);
	console.log("\n\n━━ Result ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`tier=${result.tier} model=${result.model} attempts=${result.attempts} verified=${v.verified} (${v.reason})`);
	console.log(`decisions=${result.decisions.length} · decision latency total ${totalMs}ms`);
	console.log(`\n${result.answer}`);
}
