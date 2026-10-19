/**
 * pnpm --filter jev-pi-harness cases [<id>|all] [--offline]
 *
 * Runs one or all demo cases on a scratch copy of fixtures/workspace and appends every decision to
 * decisions.jsonl (or $DECISION_LOG).
 */
import { randomUUID } from "node:crypto";
import { approveAll, denyAll, ttyApprover } from "../src/approver.ts";
import { DecisionLog } from "../src/decision-log.ts";
import { env } from "../src/env.ts";
import { runHarness } from "../src/harness.ts";
import { createTypeSafeJev, hasJevCredentials, type JevClient } from "../src/jev/client.ts";
import { scriptedJev, unavailableJev } from "../src/jev/fake.ts";
import { createOfflineLlm, createOnlineLlm, hasLlmCredentials, type LlmBackend } from "../src/llm.ts";
import { printDecision, printEvent, printResult, scratchWorkspace } from "../src/report.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const which = args.find((a) => !a.startsWith("--")) ?? "all";
const logFile = env("DECISION_LOG") ?? new URL("../decisions.jsonl", import.meta.url).pathname;

const selected = which === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.id === which || s.id.startsWith(`${which}-`));
if (selected.length === 0) {
	console.error(`Unknown case "${which}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
	process.exit(1);
}
if (!offline && !(hasJevCredentials() && hasLlmCredentials())) {
	console.error("❌ Online mode needs TYPESAFE_API_KEY and LLM_API_KEY (see .env.example). Add --offline to run the scripted version.");
	process.exit(1);
}

async function runCase(s: Scenario): Promise<void> {
	console.log(`\n\n████ ${s.id} · ${s.title} ${offline ? "(offline)" : ""}`);
	console.log(`📘 ${s.teaches}`);
	console.log(`🙋 ${s.request}`);

	let jev: JevClient;
	let llm: LlmBackend;
	if (offline) {
		jev = s.outage ? unavailableJev() : scriptedJev(s.offline.jev());
		llm = createOfflineLlm(s.offline.llm);
	} else {
		jev = s.outage ? unavailableJev() : createTypeSafeJev();
		llm = createOnlineLlm();
	}
	const approver = offline ? (s.offline.approve ? approveAll : denyAll) : ttyApprover();
	const log = new DecisionLog(`${s.id}-${randomUUID().slice(0, 8)}`, logFile, printDecision);

	const result = await runHarness({ request: s.request, workspaceDir: scratchWorkspace(), jev, llm, approver, log, onEvent: printEvent });
	printResult(result);
}

for (const s of selected) await runCase(s);
console.log(`\n📝 Decisions appended to ${logFile}`);
