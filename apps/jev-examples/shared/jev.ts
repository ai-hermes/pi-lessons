/**
 * Minimal client for the Jev (TypeSafe System One) HTTP API + answer validation helpers.
 *
 * - Automatically loads apps/jev-examples/.env (existing environment variables take precedence);
 * - TYPESAFE_API_KEY is required; calls the real endpoint `POST /v1/systemone`;
 * - Requests go through a proxy when HTTPS_PROXY / HTTP_PROXY is set (the API is region-restricted; use a proxy on 451).
 *
 * API reference: https://docs.typesafe.ai/api
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export type Instructions = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
	type: "noul";
	instructions: Instructions;
	criteria?: { true?: Instructions; false?: Instructions };
}

export interface ChoiceQuestion {
	type: "choice";
	instructions: Instructions;
	criteria: Record<string, Instructions | null>;
}

export interface ScoreQuestion {
	type: "score";
	instructions: Instructions;
	criteria: Instructions[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
	type: "noul";
	noul: number;
}

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ScoreAnswer {
	type: "score";
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
	model: string;
	state: unknown;
	questions: Record<string, Question>;
}

export interface SystemOneResponse {
	model: string;
	answers: Record<string, Answer>;
	usage: { input_tokens: number; output_tokens: number };
	/** Local field: latency (ms) */
	latencyMs: number;
}

export class JevUnavailableError extends Error {}
export class JevAnswerError extends Error {}

try {
	process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
	setGlobalDispatcher(new EnvHttpProxyAgent());
}

const BASE_URL = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 30_000);
const MAX_RETRIES = 3;

function apiKey(): string {
	const key = process.env.TYPESAFE_API_KEY?.trim();
	if (!key) {
		console.error("❌ TYPESAFE_API_KEY is not set: add it to apps/jev-examples/.env (see .env.example).");
		process.exit(1);
	}
	return key;
}

export function printMode(): void {
	apiKey();
	console.log(`✅ Calling ${BASE_URL}/v1/systemone\n`);
}

/** Calls Jev; retries 429 / 529 with exponential backoff, throws JevUnavailableError for other errors */
export async function systemOne(req: SystemOneRequest): Promise<SystemOneResponse> {
	const started = Date.now();
	const key = apiKey();

	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${BASE_URL}/v1/systemone`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(req),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (err) {
			throw new JevUnavailableError(`Request failed: ${(err as Error).message}`);
		}
		if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
			await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
			continue;
		}
		if (!res.ok) {
			throw new JevUnavailableError(`HTTP ${res.status}: ${await res.text()}`);
		}
		const body = (await res.json()) as Omit<SystemOneResponse, "latencyMs">;
		if (!body || typeof body.answers !== "object") {
			throw new JevAnswerError("Response is missing answers");
		}
		return { ...body, latencyMs: Date.now() - started };
	}
}

// ---------------------------------------------------------------------------
// Answer validation: options must come from this request and probabilities must be complete and sum to ~1, otherwise it fails
// ---------------------------------------------------------------------------

function checkDistribution(id: string, probabilities: unknown, keys: string[]): Record<string, number> {
	if (!probabilities || typeof probabilities !== "object") {
		throw new JevAnswerError(`${id}: missing probability distribution (probabilities)`);
	}
	const probs = probabilities as Record<string, number>;
	const got = Object.keys(probs).sort();
	const want = [...keys].sort();
	if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
		throw new JevAnswerError(`${id}: distribution options [${got}] do not match the request [${want}]`);
	}
	const sum = Object.values(probs).reduce((a, b) => a + b, 0);
	if (Object.values(probs).some((p) => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(sum - 1) > 0.02) {
		throw new JevAnswerError(`${id}: invalid probabilities (sum ${sum.toFixed(3)})`);
	}
	return probs;
}

export function getChoice(res: SystemOneResponse, req: SystemOneRequest, id: string): ChoiceAnswer {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "choice" || a?.type !== "choice") throw new JevAnswerError(`${id}: not a choice answer`);
	const allowed = Object.keys(q.criteria);
	if (!allowed.includes(a.choice)) throw new JevAnswerError(`${id}: returned value ${a.choice} is not one of the options [${allowed}]`);
	checkDistribution(id, a.probabilities, allowed);
	return a;
}

export function getScore(res: SystemOneResponse, req: SystemOneRequest, id: string): ScoreAnswer {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "score" || a?.type !== "score") throw new JevAnswerError(`${id}: not a score answer`);
	const levels = q.criteria.map((_, i) => String(i));
	checkDistribution(id, a.probabilities, levels);
	if (!Number.isFinite(a.score) || a.score < 0 || a.score > levels.length - 1) {
		throw new JevAnswerError(`${id}: score ${a.score} is outside 0..${levels.length - 1}`);
	}
	return a;
}

export function getNoul(res: SystemOneResponse, req: SystemOneRequest, id: string): number {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "noul" || a?.type !== "noul") throw new JevAnswerError(`${id}: not a noul answer`);
	if (!Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw new JevAnswerError(`${id}: probability ${a.noul} is outside [0, 1]`);
	return a.noul;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function section(title: string): void {
	console.log(`\n━━ ${title} ${"━".repeat(Math.max(0, 60 - title.length))}`);
}

export function printJson(label: string, value: unknown): void {
	console.log(`${label}:\n${JSON.stringify(value, null, 2)}`);
}

export const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/** Audit log: records requests, answers and local decisions for offline replay, threshold calibration and drift detection */
export function audit(event: string, data: Record<string, unknown>): void {
	console.log(`[audit] ${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}`);
}
