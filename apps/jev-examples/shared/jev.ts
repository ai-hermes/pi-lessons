/**
 * Thin wrapper around the official TypeSafe SDK (`@typesafe-ai/sdk`) + answer validation helpers.
 *
 * - Automatically loads apps/jev-examples/.env (existing environment variables take precedence);
 * - TYPESAFE_API_KEY is required (read by the SDK); TYPESAFE_BASE_URL optionally overrides the API root;
 * - Requests go through a proxy when HTTPS_PROXY / HTTP_PROXY is set (the API is region-restricted; use a proxy on 451).
 *
 * Request / answer types come straight from the SDK, so `choice` answers are typed by their option keys.
 * The SDK handles transport, retries and HTTP errors; the validators below additionally check that
 * every answer is consistent with the request before any code acts on it.
 *
 * SDK: https://www.npmjs.com/package/@typesafe-ai/sdk · API reference: https://docs.typesafe.ai/api
 */

import {
	APIConnectionError,
	APIError,
	type Fetch,
	type Question,
	type Questions,
	type SystemOneRequest,
	type SystemOneResult,
	TypeSafeClient,
} from "@typesafe-ai/sdk";
import { EnvHttpProxyAgent } from "undici";

export { choice, noul, score, type ChoiceQuestion, type ChoiceResponse, type NoulQuestion } from "@typesafe-ai/sdk";

export class JevUnavailableError extends Error { }
export class JevAnswerError extends Error { }

try {
	process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 30_000);
const MAX_RETRIES = 3;

/** Node's built-in fetch ignores HTTPS_PROXY, so hand the SDK a fetch that routes through undici's proxy agent */
function proxyFetch(): Fetch | undefined {
	const env = process.env;
	if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return undefined;
	const dispatcher = new EnvHttpProxyAgent();
	return (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
}

let client: TypeSafeClient | undefined;

function getClient(): TypeSafeClient {
	if (!process.env.TYPESAFE_API_KEY?.trim()) {
		console.error("❌ TYPESAFE_API_KEY is not set: add it to apps/jev-examples/.env (see .env.example).");
		process.exit(1);
	}
	client ??= new TypeSafeClient({ timeout: TIMEOUT_MS, retry: { maxRetries: MAX_RETRIES }, fetch: proxyFetch() });
	return client;
}

export function printMode(): void {
	console.log(`✅ Calling ${getClient().baseURL}/v1/systemone via @typesafe-ai/sdk\n`);
}

/** Calls Jev through the SDK (which retries 408 / 429 / 5xx); transport and HTTP failures become JevUnavailableError */
export async function systemOne<const Q extends Questions>(req: SystemOneRequest<Q>) {
	const started = Date.now();
	try {
		const res = await getClient().systemOne(req);
		return { ...res, latencyMs: Date.now() - started };
	} catch (err) {
		if (err instanceof APIError) throw new JevUnavailableError(`HTTP ${err.status}: ${err.message}`);
		if (err instanceof APIConnectionError) throw new JevUnavailableError(`Request failed: ${err.message}`);
		throw err;
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

// Answer types come from the SDK (`res.answers[id]` is typed per question); these only add runtime checks.
// Each takes the request too, so the answer can be checked against the options that were actually sent.

/** The SDK's answer type for question K, narrowed to the given kind (needed when questions are built dynamically) */
type AnswerOf<Q extends Questions, K extends keyof Q, T extends Question["type"]> = Extract<SystemOneResult<Q>["answers"][K], { type: T }>;

/** Looks up a question and its answer, failing unless both are of the expected type */
function pick<Q extends Questions>(res: SystemOneResult<Q>, req: SystemOneRequest<Q>, id: keyof Q & string, type: Question["type"]) {
	const q: Question | undefined = req.questions[id];
	const a = (res.answers as Record<string, any>)[id];
	if (q?.type !== type || a?.type !== type) throw new JevAnswerError(`${id}: not a ${type} answer`);
	return { q, a };
}

export function getChoice<Q extends Questions, K extends keyof Q & string>(res: SystemOneResult<Q>, req: SystemOneRequest<Q>, id: K) {
	const { q, a } = pick(res, req, id, "choice");
	const allowed = Object.keys((q as Extract<Question, { type: "choice" }>).criteria);
	if (!allowed.includes(a.choice)) throw new JevAnswerError(`${id}: returned value ${a.choice} is not one of the options [${allowed}]`);
	checkDistribution(id, a.probabilities, allowed);
	return a as AnswerOf<Q, K, "choice">;
}

export function getScore<Q extends Questions, K extends keyof Q & string>(res: SystemOneResult<Q>, req: SystemOneRequest<Q>, id: K) {
	const { q, a } = pick(res, req, id, "score");
	const levels = (q as Extract<Question, { type: "score" }>).criteria.map((_, i) => String(i));
	checkDistribution(id, a.probabilities, levels);
	if (!Number.isFinite(a.score) || a.score < 0 || a.score > levels.length - 1) {
		throw new JevAnswerError(`${id}: score ${a.score} is outside 0..${levels.length - 1}`);
	}
	return a as AnswerOf<Q, K, "score">;
}

/** Returns the probability that the answer is "yes" */
export function getNoul<Q extends Questions>(res: SystemOneResult<Q>, req: SystemOneRequest<Q>, id: keyof Q & string): number {
	const p: number = pick(res, req, id, "noul").a.noul;
	if (!Number.isFinite(p) || p < 0 || p > 1) throw new JevAnswerError(`${id}: probability ${p} is outside [0, 1]`);
	return p;
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
