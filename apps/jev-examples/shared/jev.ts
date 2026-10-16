/**
 * Jev（TypeSafe System One）HTTP API 的最小客户端 + 答案校验工具。
 *
 * - 自动加载 apps/jev-examples/.env（已存在的环境变量优先）；
 * - 必须设置 TYPESAFE_API_KEY，调用真实接口 `POST /v1/systemone`；
 * - 设置了 HTTPS_PROXY / HTTP_PROXY 时经代理请求（API 有地区限制，451 时需要代理）。
 *
 * 接口定义见 https://docs.typesafe.ai/api
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
	/** 本地字段：耗时（毫秒） */
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
		console.error("❌ 未设置 TYPESAFE_API_KEY：请在 apps/jev-examples/.env 中填写（参考 .env.example）。");
		process.exit(1);
	}
	return key;
}

export function printMode(): void {
	apiKey();
	console.log(`✅ 调用 ${BASE_URL}/v1/systemone\n`);
}

/** 调用 Jev；429 / 529 指数退避重试，其余错误直接抛出 JevUnavailableError */
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
			throw new JevUnavailableError(`请求失败：${(err as Error).message}`);
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
			throw new JevAnswerError("响应缺少 answers");
		}
		return { ...body, latencyMs: Date.now() - started };
	}
}

// ---------------------------------------------------------------------------
// 答案校验：选项必须来自本次请求、概率齐全且和约为 1，否则视为失败
// ---------------------------------------------------------------------------

function checkDistribution(id: string, probabilities: unknown, keys: string[]): Record<string, number> {
	if (!probabilities || typeof probabilities !== "object") {
		throw new JevAnswerError(`${id}：缺少概率分布 probabilities`);
	}
	const probs = probabilities as Record<string, number>;
	const got = Object.keys(probs).sort();
	const want = [...keys].sort();
	if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
		throw new JevAnswerError(`${id}：概率分布的选项 [${got}] 与请求 [${want}] 不一致`);
	}
	const sum = Object.values(probs).reduce((a, b) => a + b, 0);
	if (Object.values(probs).some((p) => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(sum - 1) > 0.02) {
		throw new JevAnswerError(`${id}：概率不合法（和为 ${sum.toFixed(3)}）`);
	}
	return probs;
}

export function getChoice(res: SystemOneResponse, req: SystemOneRequest, id: string): ChoiceAnswer {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "choice" || a?.type !== "choice") throw new JevAnswerError(`${id}：不是单选（choice）答案`);
	const allowed = Object.keys(q.criteria);
	if (!allowed.includes(a.choice)) throw new JevAnswerError(`${id}：返回值 ${a.choice} 不在选项 [${allowed}] 中`);
	checkDistribution(id, a.probabilities, allowed);
	return a;
}

export function getScore(res: SystemOneResponse, req: SystemOneRequest, id: string): ScoreAnswer {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "score" || a?.type !== "score") throw new JevAnswerError(`${id}：不是评分（score）答案`);
	const levels = q.criteria.map((_, i) => String(i));
	checkDistribution(id, a.probabilities, levels);
	if (!Number.isFinite(a.score) || a.score < 0 || a.score > levels.length - 1) {
		throw new JevAnswerError(`${id}：评分 ${a.score} 超出 0..${levels.length - 1}`);
	}
	return a;
}

export function getNoul(res: SystemOneResponse, req: SystemOneRequest, id: string): number {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "noul" || a?.type !== "noul") throw new JevAnswerError(`${id}：不是是非概率（noul）答案`);
	if (!Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw new JevAnswerError(`${id}：概率 ${a.noul} 不在 [0,1] 之间`);
	return a.noul;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export function section(title: string): void {
	console.log(`\n━━ ${title} ${"━".repeat(Math.max(0, 60 - title.length))}`);
}

export function printJson(label: string, value: unknown): void {
	console.log(`${label}：\n${JSON.stringify(value, null, 2)}`);
}

export const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/** 审计日志：记录请求、答案和本地决策，用于离线回放、阈值校准和漂移检测 */
export function audit(event: string, data: Record<string, unknown>): void {
	console.log(`[审计] ${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}`);
}
