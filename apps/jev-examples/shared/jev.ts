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
	type ResultFor,
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
	try {
		return await getClient().systemOne(req);
	} catch (err) {
		if (err instanceof APIError) throw new JevUnavailableError(`HTTP ${err.status}: ${err.message}`);
		if (err instanceof APIConnectionError) throw new JevUnavailableError(`Request failed: ${err.message}`);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Answer validation: the answer must match the question kind, choices must be one of the options, scores must be in range
// ---------------------------------------------------------------------------

// Answer types come from the SDK (`res.answers[id]` is typed per question); these only add runtime checks.
// Each takes the request too, so the answer can be checked against the options that were actually sent.

/** The SDK's answer type for question K, narrowed to the given kind (needed when questions are built dynamically) */
type AnswerOf<Q extends Questions, K extends keyof Q, T extends Question["type"]> = Extract<SystemOneResult<Q>["answers"][K], { type: T }>;

/** Any SDK answer (choice / score / noul / box response) */
type Answer = ResultFor<Question>;

/** Looks up a question and its answer, failing unless both are of the expected type */
function findQuestionAndAnswer<Q extends Questions, T extends Question["type"]>(res: SystemOneResult<Q>, req: SystemOneRequest<Q>, id: keyof Q & string, type: T) {
	const question: Question | undefined = req.questions[id];
	const answer = (res.answers as Record<string, Answer | undefined>)[id];
	// double check to ensure that question and answer should be same with expected type
	if (question?.type !== type || answer?.type !== type) {
		throw new JevAnswerError(`${id}: not a ${type} answer`);
	}
	// The check above guarantees the kind; TS cannot narrow a union by a generic `type`, so state it once here
	return {
		question: question as Extract<Question, { type: T }>,
		answer: answer as Extract<Answer, { type: T }>,
	};
}

export function getChoice<Q extends Questions, K extends keyof Q & string>(res: SystemOneResult<Q>, req: SystemOneRequest<Q>, id: K) {
	const { question, answer } = findQuestionAndAnswer(res, req, id, "choice");
	/*
	# for a choice question, `question` will be like
	{
		category: choice("Which team should handle this `ticket`?", {
			billing: "Payments, invoices, charges or refunds",
			technical: "Bugs, errors or product not working as expected",
			account: "Login, profile, plan or permission changes",
			other: "Anything that fits none of the above",
		}),
	}
	# so `allowed` will be
	["billing", "technical", "account", "other"]
	*/
	const allowed = Object.keys(question.criteria);
	if (!allowed.includes(answer.choice)) {
		throw new JevAnswerError(`${id}: returned value ${answer.choice} is not one of the options [${allowed}]`);
	}
	return answer as AnswerOf<Q, K, "choice">;
}

export function getScore<Q extends Questions, K extends keyof Q & string>(res: SystemOneResult<Q>, req: SystemOneRequest<Q>, id: K) {
	const { question, answer } = findQuestionAndAnswer(res, req, id, "score");
	// Score levels are the rubric indexes 0..n-1
	const maxScore = question.criteria.length - 1;
	if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > maxScore) {
		throw new JevAnswerError(`${id}: score ${answer.score} is outside 0..${maxScore}`);
	}
	return answer as AnswerOf<Q, K, "score">;
}

/** Returns the probability that the answer is "yes" */
export function getNoul<Q extends Questions>(res: SystemOneResult<Q>, req: SystemOneRequest<Q>, id: keyof Q & string): number {
	const { answer } = findQuestionAndAnswer(res, req, id, "noul");
	const probabilityYes = answer.noul;
	if (!Number.isFinite(probabilityYes) || probabilityYes < 0 || probabilityYes > 1) {
		throw new JevAnswerError(`${id}: probability ${probabilityYes} is outside [0, 1]`);
	}
	return probabilityYes;
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

/** Formats a probability in [0, 1] as a percentage with one decimal, e.g. 0.8734 → "87.3%" */
export function formatPercent(probability: number): string {
	const percent = probability * 100;
	return `${percent.toFixed(1)}%`;
}

