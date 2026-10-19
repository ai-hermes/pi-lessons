/**
 * Deterministic policies. Jev only produces numbers; these pure functions turn numbers into actions.
 *
 * Same input → same verdict, no network, trivially unit-testable. Thresholds below are the tutorial's
 * starting points and must be recalibrated against your own decisions.jsonl.
 */

// ---------------------------------------------------------------------------
// Gate: allow / ask / block before every tool call
// ---------------------------------------------------------------------------

export interface GateSignals {
	/** Jev: destroys or overwrites data this run did not create */
	destructive: number;
	/** Jev: hard or impossible to undo */
	irreversible: number;
	/** Code, not Jev: 1 when any path argument resolves outside the workspace, otherwise 0 */
	outsideWorkspace: number;
}

export interface GatePolicy {
	askAt: number;
	blockAt: number;
}

export const DEFAULT_GATE_POLICY: GatePolicy = { askAt: 0.65, blockAt: 0.88 };

export type GateAction = "allow" | "ask" | "block";

export interface GateVerdict {
	action: GateAction;
	worst: number;
	/** Signal that produced `worst`, for logs and approval prompts */
	driver: keyof GateSignals;
}

export function decideGate(signals: GateSignals, policy: GatePolicy = DEFAULT_GATE_POLICY): GateVerdict {
	const entries = Object.entries(signals) as Array<[keyof GateSignals, number]>;
	// A missing or malformed signal must never look safe: fail closed.
	const bad = entries.find(([, v]) => !Number.isFinite(v) || v < 0 || v > 1);
	if (bad) return { action: "block", worst: 1, driver: bad[0] };

	let [driver, worst] = entries[0]!;
	for (const [k, v] of entries) {
		if (v > worst) [driver, worst] = [k, v];
	}
	if (worst >= policy.blockAt) return { action: "block", worst, driver };
	if (worst >= policy.askAt) return { action: "ask", worst, driver };
	return { action: "allow", worst, driver };
}

// ---------------------------------------------------------------------------
// Router: pick a model tier once, before the first turn
// ---------------------------------------------------------------------------

export type Tier = "fast" | "powerful";

export interface RouterSignals {
	tier: {
		choice: Tier;
		confidence: number
	};
	/** Expected score on a 0..max rubric (0 = mechanical, max = architectural) */
	complexity: {
		score: number;
		max: number
	};
}

export interface RouterPolicy {
	/** Expected complexity at or above this forces `powerful`, whatever the tier answer says */
	escalateAtComplexity: number;
	/** Below this tier confidence, use `fallbackTier` */
	minConfidence: number;
	fallbackTier: Tier;
}

export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
	escalateAtComplexity: 1.5,
	minConfidence: 0.7,
	fallbackTier: "powerful"
};

export interface RouteVerdict {
	tier: Tier;
	reason: "escalated-by-complexity" | "low-confidence-fallback" | "jev-choice" | "jev-failed";
}

export function decideRoute(signals: RouterSignals, policy: RouterPolicy = DEFAULT_ROUTER_POLICY): RouteVerdict {
	/*
	0 -> Mechanical
	1 -> Localized
	2 -> Architectural

	default threshold is 1.5
	1 < 1.5 < 2, if score for complexity greater than 1.5,means user_request is a little bit hard, and need powerful model
	*/
	if (signals.complexity.score >= policy.escalateAtComplexity) {
		return {
			tier: "powerful",
			reason: "escalated-by-complexity"
		};
	}
	// if the jev not very sure for the result, then it will fallback to default model
	if (signals.tier.confidence < policy.minConfidence) {
		return {
			tier: policy.fallbackTier,
			reason: "low-confidence-fallback"
		};
	}
	// judge by jev, trust the choice
	return {
		tier: signals.tier.choice,
		reason: "jev-choice"
	};
}

// ---------------------------------------------------------------------------
// Verifier: accept, retry with feedback, or give up — always bounded
// ---------------------------------------------------------------------------

export interface VerifierSignals {
	/** Expected score on 0..2: 0 = does not answer, 1 = partial, 2 = fully answers */
	quality: {
		score: number;
		confidence: number
	};
	/** Probability that every factual claim is backed by files / tool results in the transcript */
	grounded: number;
}

export interface VerifierPolicy {
	acceptQualityAt: number;
	minGrounded: number;
	/** If Jev is unsure about its own grade, don't pay for another attempt */
	minJudgeConfidence: number;
	maxAttempts: number;
}

export const DEFAULT_VERIFIER_POLICY: VerifierPolicy = {
	acceptQualityAt: 1.5,
	minGrounded: 0.6,
	minJudgeConfidence: 0.5,
	maxAttempts: 2
};

export interface VerifyVerdict {
	action: "accept" | "retry" | "give-up";
	/** True only when the answer actually passed the checks */
	verified: boolean;
	reason: "passed" | "judge-unsure" | "judge-unavailable" | "attempts-exhausted" | "below-bar";
	/** Concrete gaps to hand back to the agent on retry */
	feedback: string[];
}

export function decideVerify(signals: VerifierSignals, attempt: number, policy: VerifierPolicy = DEFAULT_VERIFIER_POLICY): VerifyVerdict {
	const feedback: string[] = [];
	if (signals.quality.score < policy.acceptQualityAt) feedback.push("The answer does not fully address the request.");
	if (signals.grounded < policy.minGrounded) feedback.push("Some claims are not backed by a file you read or a tool result; read the source or drop the claim.");

	if (feedback.length === 0) return { action: "accept", verified: true, reason: "passed", feedback };
	if (signals.quality.confidence < policy.minJudgeConfidence) return { action: "accept", verified: false, reason: "judge-unsure", feedback };
	if (attempt >= policy.maxAttempts) return { action: "give-up", verified: false, reason: "attempts-exhausted", feedback };
	return { action: "retry", verified: false, reason: "below-bar", feedback };
}

// ---------------------------------------------------------------------------
// What each stage does when Jev itself is unavailable or answers garbage
// ---------------------------------------------------------------------------

export const FAILURE_POLICY = {
	/** Capability fail-open: worst case is a higher bill, the task still gets done */
	router: "powerful" as Tier,
	/** Fail closed: we cannot prove the call is safe, so it does not run */
	gate: "block" as GateAction,
	/** Return the current answer flagged as unverified; never loop on a broken judge */
	verifier: "accept-unverified" as const,
};
