/**
 * pnpm --filter jev-pi-harness start "<request>" [--workspace <dir>] [--jev-outage]
 *
 * Runs one request through the harness against real Jev + a real LLM. Without --workspace it works on a
 * scratch copy of fixtures/workspace, so nothing in the repo is touched.
 */
import { randomUUID } from "node:crypto";
import { ttyApprover } from "./approver.ts";
import { DecisionLog } from "./decision-log.ts";
import { env } from "./env.ts";
import { runHarness } from "./harness.ts";
import { createTypeSafeJev, hasJevCredentials } from "./jev/client.ts";
import { unavailableJev } from "./jev/fake.ts";
import { createOnlineLlm } from "./llm.ts";
import { printDecision, printEvent, printResult, scratchWorkspace } from "./report.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const outage = args.includes("--jev-outage");
const workspaceArg = flag("--workspace");
const request = args.filter((a) => !a.startsWith("--")).join(" ").trim();

if (!request) {
	console.error('Usage: pnpm --filter jev-pi-harness start "<request>" [--workspace <dir>] [--jev-outage]');
	process.exit(1);
}
if (!outage && !hasJevCredentials()) {
	console.error("❌ TYPESAFE_API_KEY is not set (see .env.example). Try the offline cases: pnpm --filter jev-pi-harness cases:offline");
	process.exit(1);
}

const workspaceDir = workspaceArg ?? scratchWorkspace();
const llm = createOnlineLlm();
const logFile = env("DECISION_LOG") ?? new URL("../decisions.jsonl", import.meta.url).pathname;
const log = new DecisionLog(`cli-${randomUUID().slice(0, 8)}`, logFile, printDecision);

console.log(`🗂  workspace: ${workspaceDir}\n🤖 llm: ${llm.label}\n🙋 ${request}`);
const result = await runHarness({
	request,
	workspaceDir,
	jev: outage ? unavailableJev() : createTypeSafeJev(),
	llm,
	approver: ttyApprover(),
	log,
	onEvent: printEvent,
});
printResult(result);
console.log(`\n📝 Decisions appended to ${logFile}`);
