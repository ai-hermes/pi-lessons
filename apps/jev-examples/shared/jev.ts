/**
 * Jev（TypeSafe System One）HTTP API 的最小客户端 + 答案校验工具。
 *
 * - 有 TYPESAFE_API_KEY 时调用真实接口 `POST /v1/systemone`；
 * - 没有 Key（或 JEV_MOCK=1）时使用每个案例自带的 mock 答案。mock 只用于跑通控制流，不代表 Jev 的实际效果。
 *
 * 接口定义见 https://docs.typesafe.ai/api
 */

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
	/** 本地字段：是否来自 mock */
	mocked: boolean;
	/** 本地字段：耗时（毫秒） */
	latencyMs: number;
}

export type MockFn = (req: SystemOneRequest) => Record<string, Answer>;

export class JevUnavailableError extends Error {}
export class JevAnswerError extends Error {}

const BASE_URL = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 30_000);
const MAX_RETRIES = 3;

export function isMockMode(): boolean {
	return process.env.JEV_MOCK === "1" || !process.env.TYPESAFE_API_KEY;
}

export function printMode(): void {
	if (isMockMode()) {
		console.log("⚠️  MOCK 模式：未设置 TYPESAFE_API_KEY（或 JEV_MOCK=1）。答案为固定样例，只验证控制流，不代表 Jev 实测效果。\n");
	} else {
		console.log(`✅ 真实模式：调用 ${BASE_URL}/v1/systemone\n`);
	}
}

/** 调用 Jev；429 / 529 指数退避重试，其余错误直接抛出 JevUnavailableError，不用 mock 冒充结果 */
export async function systemOne(req: SystemOneRequest, mock: MockFn): Promise<SystemOneResponse> {
	const started = Date.now();
	if (isMockMode()) {
		const answers = mock(req);
		return { model: `${req.model} (mock)`, answers, usage: { input_tokens: 0, output_tokens: 0 }, mocked: true, latencyMs: Date.now() - started };
	}

	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${BASE_URL}/v1/systemone`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
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
		const body = (await res.json()) as Omit<SystemOneResponse, "mocked" | "latencyMs">;
		if (!body || typeof body.answers !== "object") {
			throw new JevAnswerError("响应缺少 answers");
		}
		return { ...body, mocked: false, latencyMs: Date.now() - started };
	}
}

// ---------------------------------------------------------------------------
// 答案校验：选项必须来自本次请求、概率齐全且和约为 1，否则视为失败
// ---------------------------------------------------------------------------

function checkDistribution(id: string, probabilities: unknown, keys: string[]): Record<string, number> {
	if (!probabilities || typeof probabilities !== "object") {
		throw new JevAnswerError(`${id}: 缺少 probabilities`);
	}
	const probs = probabilities as Record<string, number>;
	const got = Object.keys(probs).sort();
	const want = [...keys].sort();
	if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
		throw new JevAnswerError(`${id}: 概率分布的选项 [${got}] 与请求 [${want}] 不一致`);
	}
	const sum = Object.values(probs).reduce((a, b) => a + b, 0);
	if (Object.values(probs).some((p) => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(sum - 1) > 0.02) {
		throw new JevAnswerError(`${id}: 概率不合法（和为 ${sum.toFixed(3)}）`);
	}
	return probs;
}

export function getChoice(res: SystemOneResponse, req: SystemOneRequest, id: string): ChoiceAnswer {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "choice" || a?.type !== "choice") throw new JevAnswerError(`${id}: 不是 choice 答案`);
	const allowed = Object.keys(q.criteria);
	if (!allowed.includes(a.choice)) throw new JevAnswerError(`${id}: 返回值 ${a.choice} 不在选项 [${allowed}] 中`);
	checkDistribution(id, a.probabilities, allowed);
	return a;
}

export function getScore(res: SystemOneResponse, req: SystemOneRequest, id: string): ScoreAnswer {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "score" || a?.type !== "score") throw new JevAnswerError(`${id}: 不是 score 答案`);
	const levels = q.criteria.map((_, i) => String(i));
	checkDistribution(id, a.probabilities, levels);
	if (!Number.isFinite(a.score) || a.score < 0 || a.score > levels.length - 1) {
		throw new JevAnswerError(`${id}: score ${a.score} 超出 0..${levels.length - 1}`);
	}
	return a;
}

export function getNoul(res: SystemOneResponse, req: SystemOneRequest, id: string): number {
	const q = req.questions[id];
	const a = res.answers[id];
	if (q?.type !== "noul" || a?.type !== "noul") throw new JevAnswerError(`${id}: 不是 noul 答案`);
	if (!Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw new JevAnswerError(`${id}: noul ${a.noul} 不在 [0,1]`);
	return a.noul;
}

// ---------------------------------------------------------------------------
// mock 构造器：只按 API 的响应格式造数据
// ---------------------------------------------------------------------------

export function mockNoul(p: number): NoulAnswer {
	return { type: "noul", noul: p };
}

/** 给定部分选项的概率，剩余概率平均分给其他选项 */
export function mockChoice(question: Question | undefined, partial: Record<string, number>): ChoiceAnswer {
	if (question?.type !== "choice") throw new Error("mockChoice 需要 choice 问题");
	const keys = Object.keys(question.criteria);
	const used = Object.values(partial).reduce((a, b) => a + b, 0);
	const rest = keys.filter((k) => !(k in partial));
	const probabilities = Object.fromEntries(
		keys.map((k) => [k, k in partial ? partial[k]! : rest.length ? (1 - used) / rest.length : 0]),
	);
	const [choice, top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
	return { type: "choice", choice, probabilities, confidence: top };
}

export function mockScore(question: Question | undefined, probs: number[]): ScoreAnswer {
	if (question?.type !== "score") throw new Error("mockScore 需要 score 问题");
	const legend = Object.fromEntries(question.criteria.map((c, i) => [String(i), typeof c === "string" ? c : JSON.stringify(c)]));
	const probabilities = Object.fromEntries(probs.map((p, i) => [String(i), p]));
	const score = probs.reduce((acc, p, i) => acc + p * i, 0);
	return { type: "score", score, legend, probabilities, confidence: Math.max(...probs) };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export function section(title: string): void {
	console.log(`\n━━ ${title} ${"━".repeat(Math.max(0, 60 - title.length))}`);
}

export function printJson(label: string, value: unknown): void {
	console.log(`${label}:\n${JSON.stringify(value, null, 2)}`);
}

export const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/** 审计日志：记录请求、答案和本地决策，用于离线回放、阈值校准和漂移检测 */
export function audit(event: string, data: Record<string, unknown>): void {
	console.log(`[audit] ${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}`);
}
