/**
 * Offline Jev: a handler returns just the numbers, this wraps them as SDK-shaped answers so the stages
 * go through the same answer readers as with the real service.
 */
import { JevUnavailableError, type JevClient, type Questions, type SystemOneRequest, type SystemOneResult } from "./client.ts";

export type FakeAnswer = { noul: number } | { choice: string; confidence: number } | { score: number; confidence: number };
export type FakeHandler = (req: SystemOneRequest<Questions>) => Partial<Record<string, FakeAnswer>>;

export function scriptedJev(handler: FakeHandler): JevClient {
	const model = "jev-scripted";
	return {
		model,
		async ask<const Q extends Questions>(req: SystemOneRequest<Q>) {
			const answers: Record<string, unknown> = {};
			for (const [id, value] of Object.entries(handler(req))) {
				if (!value) continue;
				const type = req.questions[id]?.type;
				if ("noul" in value) answers[id] = { type, noul: value.noul };
				else if ("choice" in value) answers[id] = { type, choice: value.choice, confidence: value.confidence };
				else answers[id] = { type, score: value.score, confidence: value.confidence };
			}
			return { model, answers } as unknown as SystemOneResult<Q>;
		},
	};
}

export function unavailableJev(): JevClient {
	return {
		model: "jev-down",
		async ask() {
			throw new JevUnavailableError("simulated outage: 503 Service Unavailable");
		},
	};
}

/** Which stage is asking, judged by question ids, so one handler can script a whole run */
export function stageOf(req: SystemOneRequest<Questions>): "router" | "gate" | "verifier" {
	if ("tier" in req.questions) return "router";
	if ("destructive" in req.questions) return "gate";
	return "verifier";
}
