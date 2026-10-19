/**
 * Jev access for the harness.
 *
 * Everything that talks to Jev goes through the tiny `JevClient` interface, so the stages can be driven by
 * the real TypeSafe SDK, by a scripted fake (tests / offline cases) or by a client that always fails
 * (outage drills) without changing any stage code.
 */
import {
	APIConnectionError,
	APIError,
	type Fetch,
	type Question,
	type Questions,
	type ResultFor,
	type SystemOneRequest,
	type SystemOneResult,
	TypeSafeClient,
} from "@typesafe-ai/sdk";
import { EnvHttpProxyAgent } from "undici";
import { env } from "@/env.ts";

export { choice, noul, score } from "@typesafe-ai/sdk";
export type { JsonValue, Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";

/** Transport failure, timeout, rate limit, 5xx … — the stage must apply its failure policy. */
export class JevUnavailableError extends Error {}
/** Jev answered, but the answer does not fit the question (wrong kind, unknown label, out of range). */
export class JevAnswerError extends Error {}

export interface JevClient {
	readonly model: string;
	ask<const Q extends Questions>(req: SystemOneRequest<Q>): Promise<SystemOneResult<Q>>;
}

export const DEFAULT_JEV_MODEL = "jev-1.13.0";

function proxyFetch(): Fetch | undefined {
	if (!(env("HTTPS_PROXY") || env("https_proxy") || env("HTTP_PROXY") || env("http_proxy"))) return undefined;
	const dispatcher = new EnvHttpProxyAgent();
	return (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
}

/** Real Jev through `@typesafe-ai/sdk`. One quick retry only: a stuck decision blocks the agent loop. */
export function createTypeSafeJev(): JevClient {
	const model = env("JEV_MODEL") ?? DEFAULT_JEV_MODEL;
	const client = new TypeSafeClient({
		timeout: Number(env("JEV_TIMEOUT_MS") ?? 8_000),
		retry: { maxRetries: 1 },
		fetch: proxyFetch(),
	});
	return {
		model,
		async ask(req) {
			try {
				return await client.systemOne({ ...req, model: req.model ?? model });
			} catch (err) {
				if (err instanceof APIError) throw new JevUnavailableError(`HTTP ${err.status}: ${err.message}`);
				if (err instanceof APIConnectionError) throw new JevUnavailableError(`Request failed: ${err.message}`);
				throw err;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Answer readers: never act on an answer that does not match what was asked
// ---------------------------------------------------------------------------

type AnyAnswer = ResultFor<Question>;

function pick<T extends Question["type"]>(res: SystemOneResult<Questions>, req: SystemOneRequest<Questions>, id: string, type: T) {
	const question = req.questions[id];
	const answer = (res.answers as Record<string, AnyAnswer | undefined>)[id];
	if (question?.type !== type || answer?.type !== type) throw new JevAnswerError(`${id}: missing or not a ${type} answer`);
	return { question: question as Extract<Question, { type: T }>, answer: answer as Extract<AnyAnswer, { type: T }> };
}

function assertUnit(id: string, label: string, value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) throw new JevAnswerError(`${id}: ${label} ${value} is outside [0, 1]`);
}

export function readNoul(res: SystemOneResult<Questions>, req: SystemOneRequest<Questions>, id: string): number {
	const { answer } = pick(res, req, id, "noul");
	assertUnit(id, "probability", answer.noul);
	return answer.noul;
}

export function readChoice(res: SystemOneResult<Questions>, req: SystemOneRequest<Questions>, id: string): { choice: string; confidence: number } {
	const { question, answer } = pick(res, req, id, "choice");
	if (!Object.keys(question.criteria).includes(answer.choice)) throw new JevAnswerError(`${id}: "${answer.choice}" is not an offered option`);
	assertUnit(id, "confidence", answer.confidence);
	return { choice: answer.choice, confidence: answer.confidence };
}

/** Score levels are rubric indexes 0..n-1; Jev returns the expected score, which can fall between levels. */
export function readScore(res: SystemOneResult<Questions>, req: SystemOneRequest<Questions>, id: string): { score: number; confidence: number; max: number } {
	const { question, answer } = pick(res, req, id, "score");
	const max = question.criteria.length - 1;
	if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > max) throw new JevAnswerError(`${id}: score ${answer.score} is outside 0..${max}`);
	assertUnit(id, "confidence", answer.confidence);
	return { score: answer.score, confidence: answer.confidence, max };
}
