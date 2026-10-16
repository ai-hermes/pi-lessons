/**
 * 案例 4：RAG 候选筛选与重排（每个候选一个 Noul）
 *
 * 文档分块 → 查询改写 → 混合检索召回 → 去重/分批 → Jev 逐个判断
 * → 代码按概率排序并按阈值过滤 → 生成模型回答 → 引用校验
 */
import {
	audit,
	getNoul,
	JevUnavailableError,
	pct,
	printMode,
	section,
	systemOne,
	type SystemOneRequest,
} from "./shared/jev.ts";

// 官方示例手册的取值，需要用自己的数据校准
const KEEP_THRESHOLD = 0.55;
const TOP_K = 6;
const BATCH_SIZE = 10;

// ---- 1. 离线准备的文档库：分块 + 元数据 ------------------------------------
interface Chunk {
	id: string;
	text: string;
	source: string;
	/** 同一条政策在多处出现时用于去重 */
	topic: string;
	updatedAt: string;
}

const LIBRARY: Chunk[] = [
	{ id: "faq-12", topic: "退款时效", source: "常见问题", updatedAt: "2025-03-01", text: "退款批准后一般 7–14 个工作日原路退回。" },
	{ id: "terms-4.2", topic: "退款时效", source: "服务条款 v3", updatedAt: "2026-08-01", text: "退款批准后通常在 5–10 个工作日原路退回。" },
	{ id: "faq-03", topic: "取消订阅", source: "常见问题", updatedAt: "2026-05-10", text: "订阅可在账户设置中取消。" },
	{ id: "faq-07", topic: "发票", source: "常见问题", updatedAt: "2026-02-11", text: "发票会在每月第一个工作日生成。" },
	{ id: "faq-09", topic: "申请退款", source: "常见问题", updatedAt: "2026-04-02", text: "在订单页面点击“申请退款”提交退款申请。" },
	{ id: "blog-21", topic: "版本发布", source: "博客", updatedAt: "2026-09-30", text: "新版仪表盘支持自定义主题。" },
];

// ---- 2. 查询改写：补同义词，生成多条查询 ------------------------------------
const SYNONYMS: Record<string, string[]> = {
	到账: ["原路退回", "退回"],
	多久: ["工作日", "时间"],
};

function rewriteQuery(query: string): string[] {
	const queries = [query];
	for (const [word, alts] of Object.entries(SYNONYMS)) {
		if (query.includes(word)) for (const alt of alts) queries.push(query.replace(word, alt));
	}
	return queries;
}

// ---- 3. 混合检索：关键词（BM25 简化版）+ “向量”（字符二元组余弦，演示用） ----
const bigrams = (s: string) => {
	const t = s.replace(/[\s，。？！、“”]/g, "");
	return Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2));
};

function keywordScore(query: string, doc: string): number {
	const terms = new Set(bigrams(query));
	const docTerms = bigrams(doc);
	let score = 0;
	for (const term of terms) {
		const tf = docTerms.filter((t) => t === term).length;
		const df = LIBRARY.filter((c) => c.text.includes(term)).length;
		if (tf) score += Math.log(1 + LIBRARY.length / df) * ((tf * 2.2) / (tf + 1.2));
	}
	return score;
}

function vectorScore(query: string, doc: string): number {
	const a = bigrams(query);
	const b = new Set(bigrams(doc));
	const overlap = a.filter((x) => b.has(x)).length;
	return overlap / Math.sqrt(Math.max(1, a.length) * Math.max(1, b.size));
}

function hybridRetrieve(queries: string[], k: number): Chunk[] {
	// 倒数排名融合（RRF）合并两路结果
	const fused = new Map<string, number>();
	for (const q of queries) {
		for (const scorer of [keywordScore, vectorScore]) {
			const ranked = [...LIBRARY].sort((x, y) => scorer(q, y.text) - scorer(q, x.text));
			ranked.forEach((c, rank) => fused.set(c.id, (fused.get(c.id) ?? 0) + 1 / (60 + rank)));
		}
	}
	return [...LIBRARY].sort((x, y) => fused.get(y.id)! - fused.get(x.id)!).slice(0, k);
}

// ---- 4. 去重：同一主题只保留最新版本 ----------------------------------------
function dedupeLatest(chunks: Chunk[]): Chunk[] {
	const latest = new Map<string, Chunk>();
	for (const c of chunks) {
		const prev = latest.get(c.topic);
		if (!prev || c.updatedAt > prev.updatedAt) latest.set(c.topic, c);
	}
	return chunks.filter((c) => latest.get(c.topic) === c);
}

// ---- 5. 每个候选一个 Noul ---------------------------------------------------
interface Candidate {
	id: string;
	chunk: Chunk;
}

const questionId = (c: Candidate) => `${c.id}能否回答`;

function buildRequest(query: string, batch: Candidate[]): SystemOneRequest {
	return {
		model: "jev-latest",
		state: { 查询: query, 候选: batch.map((c) => ({ 编号: c.id, 内容: c.chunk.text })) },
		questions: Object.fromEntries(
			batch.map((c) => [
				questionId(c),
				{ type: "noul", instructions: `\`候选\` 中编号为「${c.id}」的那一项，其 \`内容\` 是否包含可以直接回答 \`查询\` 的信息？` },
			]),
		),
	};
}

// ---- 生成 + 引用校验（生成模型用桩代替） -------------------------------------
function generateAnswer(query: string, kept: Candidate[]): { text: string; citations: string[] } {
	const top = kept[0]!;
	return { text: `${top.chunk.text.replace("。", "")} [${top.id}]`, citations: [top.id] };
}

printMode();
const query = "退款到账通常需要多久？";
section(`查询：${query}`);
const queries = rewriteQuery(query);
console.log("改写后的查询：", queries);

const recalled = hybridRetrieve(queries, TOP_K);
console.log("召回：", recalled.map((c) => c.id));
const deduped = dedupeLatest(recalled);
console.log("去重后：", deduped.map((c) => `${c.id}(${c.updatedAt})`));

const candidates: Candidate[] = deduped.map((chunk, i) => ({ id: `候选${i + 1}`, chunk }));
const scored: Array<Candidate & { p: number }> = [];
for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
	const batch = candidates.slice(i, i + BATCH_SIZE);
	const req = buildRequest(query, batch);
	try {
		const res = await systemOne(req);
		for (const c of batch) scored.push({ ...c, p: getNoul(res, req, questionId(c)) });
	} catch (err) {
		// 判断失败的候选不参与打分
		if (!(err instanceof JevUnavailableError)) throw err;
		console.log(`批次 ${i / BATCH_SIZE} 调用失败，跳过：${err.message}`);
	}
}

section("Jev 判定 + 代码排序过滤");
scored.sort((a, b) => b.p - a.p);
for (const c of scored) {
	console.log(`${c.p >= KEEP_THRESHOLD ? "保留" : "丢弃"}  ${c.id}  概率 ${pct(c.p)}  [${c.chunk.source}] ${c.chunk.text}`);
}
const kept = scored.filter((c) => c.p >= KEEP_THRESHOLD);

section("回答");
if (!kept.length) {
	console.log("未找到相关资料（不调用生成模型）");
} else {
	const answer = generateAnswer(query, kept);
	const keptIds = new Set(kept.map((c) => c.id));
	const valid = answer.citations.length > 0 && answer.citations.every((id) => keptIds.has(id));
	console.log(valid ? answer.text : "引用校验失败：答案引用了未保留的片段，不展示，转人工处理");
	for (const id of answer.citations) {
		const c = kept.find((k) => k.id === id);
		if (c) console.log(`  [${id}] 来源：${c.chunk.source}（${c.chunk.id}，更新于 ${c.chunk.updatedAt}）`);
	}
}
audit("rag.filter", { query, threshold: KEEP_THRESHOLD, scores: scored.map((c) => ({ id: c.chunk.id, p: c.p })), kept: kept.map((c) => c.chunk.id) });
