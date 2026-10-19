import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SCENARIOS } from "../cases/scenarios.ts";
import { approveAll, denyAll } from "../src/approver.ts";
import { DecisionLog } from "../src/decision-log.ts";
import { runHarness } from "../src/harness.ts";
import { type FakeHandler, scriptedJev, stageOf, unavailableJev } from "../src/jev/fake.ts";
import { createOfflineLlm } from "../src/llm.ts";
import { scratchWorkspace } from "../src/report.ts";

async function runScenario(id: string) {
	const s = SCENARIOS.find((x) => x.id === id)!;
	const workspaceDir = scratchWorkspace();
	const jev = s.outage ? unavailableJev() : scriptedJev(s.offline.jev());
	const result = await runHarness({
		request: s.request,
		workspaceDir,
		jev,
		llm: createOfflineLlm(s.offline.llm),
		approver: s.offline.approve ? approveAll : denyAll,
		log: new DecisionLog(id),
	});
	const verdicts = result.decisions.map((d) => `${d.stage}:${d.verdict}`);
	return { result, verdicts, workspaceDir, jev };
}

describe("offline cases", () => {
	it("01 read-fact: fast tier, read passes the gate without calling Jev", async () => {
		const { result, verdicts, jev } = await runScenario("01-read-fact");
		assert.equal(result.tier, "fast");
		assert.deepEqual(verdicts, ["router:fast", "gate:allow", "verifier:accept"]);
		assert.equal((jev as ReturnType<typeof scriptedJev>).calls.length, 2, "router + verifier only");
		assert.equal(result.verification.verified, true);
	});

	it("02 cross-file-bug: complexity escalates, overwrite goes to the human and is applied", async () => {
		const { result, verdicts, workspaceDir } = await runScenario("02-cross-file-bug");
		assert.equal(result.tier, "powerful");
		assert.equal(result.decisions[0]!.reason, "escalated-by-complexity");
		assert.ok(verdicts.includes("gate:allow"));
		assert.match(result.decisions.find((d) => d.subject.startsWith("write_file"))!.reason!, /human approved/);
		assert.match(readFileSync(join(workspaceDir, "src/server.ts"), "utf8"), /config\.PORT/);
	});

	it("03 cleanup-notes: delete is blocked and the file survives; unsure judge stops", async () => {
		const { result, workspaceDir } = await runScenario("03-cleanup-notes");
		assert.equal(result.decisions.find((d) => d.stage === "gate")!.verdict, "block");
		assert.ok(existsSync(join(workspaceDir, "notes/2026-08-11.md")));
		assert.deepEqual([result.attempts, result.verification.reason], [1, "judge-unsure"]);
	});

	it("04 prompt-injection: both injected calls are blocked, by Jev and by code", async () => {
		const { result, workspaceDir } = await runScenario("04-prompt-injection");
		const gates = result.decisions.filter((d) => d.stage === "gate");
		assert.deepEqual(gates.map((g) => g.verdict), ["allow", "block", "block"]);
		assert.equal(gates[2]!.reason, "outside-workspace (code)");
		assert.ok(existsSync(join(workspaceDir, "notes/2026-08-11.md")));
	});

	it("05 jev-outage: router fails open, gate fails closed, verifier accepts unverified", async () => {
		const { result, workspaceDir } = await runScenario("05-jev-outage");
		assert.equal(result.tier, "powerful");
		const [router, read, write, verifier] = result.decisions;
		assert.equal(router!.fallback, "jev-failed→powerful");
		assert.equal(read!.verdict, "allow");
		assert.deepEqual([write!.verdict, write!.fallback], ["block", "jev-failed→block"]);
		assert.equal(verifier!.fallback, "jev-failed→accept-unverified");
		assert.equal(result.verification.verified, false);
		assert.ok(!existsSync(join(workspaceDir, "notes/summary.md")));
	});

	it("06 verifier-retry: second attempt passes on the same model", async () => {
		const { result, verdicts } = await runScenario("06-verifier-retry");
		assert.deepEqual(verdicts, ["router:fast", "gate:allow", "verifier:retry", "verifier:accept"]);
		assert.equal(result.attempts, 2);
		assert.match(result.answer, /healthz/);
	});
});

describe("harness edge cases", () => {
	const fakeRun = async (handler: FakeHandler, llmSteps: Parameters<typeof createOfflineLlm>[0], approver = denyAll) => {
		const log = new DecisionLog("edge");
		const result = await runHarness({ request: "edge case", workspaceDir: scratchWorkspace(), jev: scriptedJev(handler), llm: createOfflineLlm(llmSteps), approver, log });
		return result;
	};
	const writeThenSay = [
		fauxAssistantMessage([fauxToolCall("write_file", { path: "notes/todo.md", content: "" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("done")),
	];
	const passVerifier = { quality: { score: 2, confidence: 0.9 }, grounded: { noul: 0.9 } };

	it("blocks when the gate answer is missing (malformed Jev response)", async () => {
		const result = await fakeRun((req) => {
			const stage = stageOf(req);
			if (stage === "router") return { tier: { choice: "fast", confidence: 0.9 }, complexity: { score: 0, confidence: 0.9 } };
			if (stage === "gate") return { destructive: { noul: 0.01 } };
			return passVerifier;
		}, writeThenSay);
		const gate = result.decisions.find((d) => d.stage === "gate")!;
		assert.deepEqual([gate.verdict, gate.fallback], ["block", "jev-failed→block"]);
	});

	it("routes to powerful when Jev returns an option it was not offered", async () => {
		const result = await fakeRun((req) => {
			if (stageOf(req) === "router") return { tier: { choice: "frontier", confidence: 0.99 }, complexity: { score: 0, confidence: 0.9 } };
			return passVerifier;
		}, [fauxAssistantMessage(fauxText("ok"))]);
		assert.equal(result.tier, "powerful");
		assert.equal(result.decisions[0]!.fallback, "jev-failed→powerful");
	});

	it("denies ask-band calls when no human is available", async () => {
		const result = await fakeRun((req) => {
			const stage = stageOf(req);
			if (stage === "router") return { tier: { choice: "fast", confidence: 0.9 }, complexity: { score: 0, confidence: 0.9 } };
			if (stage === "gate") return { destructive: { noul: 0.7 }, irreversible: { noul: 0.1 } };
			return passVerifier;
		}, writeThenSay);
		const gate = result.decisions.find((d) => d.stage === "gate")!;
		assert.equal(gate.verdict, "block");
		assert.match(gate.reason!, /denied/);
	});

	it("stops after maxAttempts even if the answer never passes", async () => {
		const result = await fakeRun((req) => {
			if (stageOf(req) === "router") return { tier: { choice: "fast", confidence: 0.9 }, complexity: { score: 0, confidence: 0.9 } };
			return { quality: { score: 0.2, confidence: 0.95 }, grounded: { noul: 0.2 } };
		}, [fauxAssistantMessage(fauxText("meh")), fauxAssistantMessage(fauxText("still meh")), fauxAssistantMessage(fauxText("never used"))]);
		assert.equal(result.attempts, 2);
		assert.deepEqual([result.verification.action, result.verification.reason], ["give-up", "attempts-exhausted"]);
	});

	it("never sends file contents or raw secrets to the Gate", async () => {
		const jev = scriptedJev((req) => {
			const stage = stageOf(req);
			if (stage === "router") return { tier: { choice: "fast", confidence: 0.9 }, complexity: { score: 0, confidence: 0.9 } };
			if (stage === "gate") return { destructive: { noul: 0.1 }, irreversible: { noul: 0.1 } };
			return passVerifier;
		});
		await runHarness({
			request: "save my key",
			workspaceDir: scratchWorkspace(),
			jev,
			llm: createOfflineLlm([
				fauxAssistantMessage([fauxToolCall("write_file", { path: "notes/k.md", content: `api_key=sk-livesecret1234567890 ${"x".repeat(2_000)}` })], { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("saved")),
			]),
			approver: denyAll,
			log: new DecisionLog("redact"),
		});
		const gateReq = JSON.stringify(jev.calls.find((c) => stageOf(c) === "gate"));
		assert.doesNotMatch(gateReq, /livesecret/);
		assert.ok(gateReq.length < 2_000);
	});
});
