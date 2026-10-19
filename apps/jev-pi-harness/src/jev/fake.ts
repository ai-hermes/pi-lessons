/**
 * Jev stand-ins for tests, offline cases and outage drills.
 *
 * `scriptedJev` answers from a handler; the handler only returns the numbers, this module dresses them
 * up as SDK-shaped answers so the stages exercise exactly the same readers as with the real service.
 */
import { JevUnavailableError, type JevClient, type Questions, type SystemOneRequest, type SystemOneResult } from "./client.ts";

export type FakeAnswer =
	| { noul: number }
	| { choice: string; confidence: number }
	| { score: number; confidence: number };

/** Return `undefined` for a question to simulate a missing answer, or throw to simulate an outage. */
export type FakeHandler = (req: SystemOneRequest<Questions>) => Record<string, FakeAnswer | undefined>;

export function scriptedJev(handler: FakeHandler, model = "jev-scripted"): JevClient & { calls: SystemOneRequest<Questions>[] } {
	const calls: SystemOneRequest<Questions>[] = [];
	return {
		model,
		calls,
		async ask<const Q extends Questions>(req: SystemOneRequest<Q>) {
			calls.push(req);
			const raw = handler(req);
			const answers: Record<string, unknown> = {};
			for (const [id, value] of Object.entries(raw)) {
				if (!value) continue;
				const type = req.questions[id]?.type;
				if ("noul" in value) answers[id] = { type: type ?? "noul", noul: value.noul };
				else if ("choice" in value) answers[id] = { type: type ?? "choice", choice: value.choice, confidence: value.confidence, probabilities: { [value.choice]: value.confidence } };
				else answers[id] = { type: type ?? "score", score: value.score, confidence: value.confidence, legend: {}, probabilities: {} };
			}
			return { model, answers, usage: { input_tokens: null, output_tokens: null } } as unknown as SystemOneResult<Q>;
		},
	};
}

/** Every call fails like a timeout / 503 would. */
export function unavailableJev(reason = "simulated outage: 503 Service Unavailable"): JevClient {
	return {
		model: "jev-down",
		async ask() {
			throw new JevUnavailableError(reason);
		},
	};
}

/** Picks the stage from the question ids so one handler can script a whole run. */
export function stageOf(req: SystemOneRequest<Questions>): "router" | "gate" | "verifier" | "unknown" {
	const ids = Object.keys(req.questions);
	if (ids.includes("tier")) return "router";
	if (ids.includes("destructive")) return "gate";
	if (ids.includes("quality")) return "verifier";
	return "unknown";
}
