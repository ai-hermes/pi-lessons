import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideGate, decideRoute, decideVerify, DEFAULT_GATE_POLICY, DEFAULT_VERIFIER_POLICY } from "@/policies.ts";

const gate = (destructive: number, irreversible: number, outsideWorkspace = 0) => decideGate({ destructive, irreversible, outsideWorkspace });

describe("decideGate", () => {
	it("maps the tutorial examples to allow / ask / block", () => {
		assert.equal(gate(0.01, 0.03, 0.02).action, "allow");
		assert.equal(gate(0.83, 0.66, 0.03).action, "ask");
		assert.equal(gate(0.95, 0.7, 0.02).action, "block");
	});

	it("treats values exactly on a threshold as the stricter band", () => {
		assert.equal(gate(DEFAULT_GATE_POLICY.askAt, 0).action, "ask");
		assert.equal(gate(DEFAULT_GATE_POLICY.blockAt, 0).action, "block");
		assert.equal(gate(DEFAULT_GATE_POLICY.askAt - 0.0001, 0).action, "allow");
	});

	it("uses the worst signal and reports which one drove it", () => {
		const v = gate(0.1, 0.9);
		assert.equal(v.action, "block");
		assert.equal(v.driver, "irreversible");
	});

	it("blocks when the code-computed outsideWorkspace signal is set", () => {
		assert.equal(gate(0, 0, 1).action, "block");
	});

	it("fails closed on missing or malformed signals", () => {
		assert.equal(gate(Number.NaN, 0).action, "block");
		assert.equal(gate(0, -0.1).action, "block");
		assert.equal(gate(0, 1.2).action, "block");
		assert.equal(decideGate({ destructive: 0, irreversible: undefined as unknown as number, outsideWorkspace: 0 }).action, "block");
	});

	it("is deterministic", () => {
		assert.deepEqual(gate(0.7, 0.2), gate(0.7, 0.2));
	});
});

describe("decideRoute", () => {
	const signals = (choice: "fast" | "powerful", confidence: number, complexity: number) => ({ tier: { choice, confidence }, complexity: { score: complexity, max: 2 } });

	it("escalates to powerful on high complexity even if Jev chose fast confidently", () => {
		assert.deepEqual(decideRoute(signals("fast", 0.99, 1.5)), { tier: "powerful", reason: "escalated-by-complexity" });
	});

	it("falls back when the tier answer is not confident", () => {
		assert.deepEqual(decideRoute(signals("fast", 0.6, 0.2)), { tier: "powerful", reason: "low-confidence-fallback" });
	});

	it("otherwise follows Jev's choice", () => {
		assert.deepEqual(decideRoute(signals("fast", 0.9, 0.2)), { tier: "fast", reason: "jev-choice" });
		assert.deepEqual(decideRoute(signals("powerful", 0.9, 0.2)), { tier: "powerful", reason: "jev-choice" });
	});
});

describe("decideVerify", () => {
	const s = (quality: number, grounded: number, confidence = 0.9) => ({ quality: { score: quality, confidence }, grounded });

	it("accepts at exactly the quality bar", () => {
		const v = decideVerify(s(DEFAULT_VERIFIER_POLICY.acceptQualityAt, 0.9), 1);
		assert.equal(v.action, "accept");
		assert.equal(v.verified, true);
	});

	it("retries with feedback while attempts remain", () => {
		const v = decideVerify(s(1.0, 0.9), 1);
		assert.equal(v.action, "retry");
		assert.equal(v.feedback.length, 1);
	});

	it("asks for grounding when claims are unsupported", () => {
		const v = decideVerify(s(2, 0.3), 1);
		assert.equal(v.action, "retry");
		assert.match(v.feedback[0]!, /not backed/);
	});

	it("gives up when attempts are exhausted", () => {
		const v = decideVerify(s(1.0, 0.9), DEFAULT_VERIFIER_POLICY.maxAttempts);
		assert.deepEqual([v.action, v.verified, v.reason], ["give-up", false, "attempts-exhausted"]);
	});

	it("accepts unverified instead of paying for a retry when the judge is unsure", () => {
		const v = decideVerify(s(1.0, 0.9, 0.3), 1);
		assert.deepEqual([v.action, v.verified, v.reason], ["accept", false, "judge-unsure"]);
	});
});
