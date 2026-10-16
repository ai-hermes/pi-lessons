/**
 * Case 4: RAG candidate filtering and reranking (one Noul per candidate)
 *
 * Chunk documents → rewrite query → hybrid retrieval → dedupe/batch → Jev judges each candidate
 * → code sorts by probability and filters by threshold → generative model answers → citation check
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

// Values from the official example playbook; calibrate them against your own data
const KEEP_THRESHOLD = 0.55;
const TOP_K = 6;
const BATCH_SIZE = 10;

// ---- 1. Offline-prepared library: chunks + metadata -------------------------
interface Chunk {
	id: string;
	text: string;
	source: string;
	/** Used for dedupe when the same policy appears in several places */
	topic: string;
	updatedAt: string;
}

const LIBRARY: Chunk[] = [
	{ id: "faq-12", topic: "refund_timing", source: "FAQ", updatedAt: "2025-03-01", text: "Once a refund is approved, it is usually returned to the original payment method within 7–14 business days." },
	{ id: "terms-4.2", topic: "refund_timing", source: "Terms of Service v3", updatedAt: "2026-08-01", text: "Once a refund is approved, it is typically returned to the original payment method within 5–10 business days." },
	{ id: "faq-03", topic: "cancel_subscription", source: "FAQ", updatedAt: "2026-05-10", text: "You can cancel your subscription in account settings." },
	{ id: "faq-07", topic: "invoices", source: "FAQ", updatedAt: "2026-02-11", text: "Invoices are generated on the first business day of each month." },
	{ id: "faq-09", topic: "request_refund", source: "FAQ", updatedAt: "2026-04-02", text: "To request a refund, click \"Request refund\" on the order page." },
	{ id: "blog-21", topic: "release_notes", source: "Blog", updatedAt: "2026-09-30", text: "The new dashboard supports custom themes." },
];

// ---- 2. Query rewriting: add synonyms to produce multiple queries -----------
const SYNONYMS: Record<string, string[]> = {
	get: ["receive"],
	"how long": ["how many business days"],
};

function rewriteQuery(query: string): string[] {
	const queries = [query];
	for (const [phrase, alts] of Object.entries(SYNONYMS)) {
		const pattern = new RegExp(`\\b${phrase}\\b`, "i");
		if (pattern.test(query)) for (const alt of alts) queries.push(query.replace(pattern, alt));
	}
	return queries;
}

// ---- 3. Hybrid retrieval: keyword (simplified BM25) + "vector" (word-token cosine, demo only) ----
const STOPWORDS = new Set(["a", "an", "the", "is", "it", "to", "do", "does", "i", "my", "of", "on", "in", "for", "you", "your", "once", "within"]);

const tokens = (s: string) =>
	s
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t && !STOPWORDS.has(t));

function keywordScore(query: string, doc: string): number {
	const terms = new Set(tokens(query));
	const docTerms = tokens(doc);
	let score = 0;
	for (const term of terms) {
		const tf = docTerms.filter((t) => t === term).length;
		const df = LIBRARY.filter((c) => tokens(c.text).includes(term)).length;
		if (tf) score += Math.log(1 + LIBRARY.length / df) * ((tf * 2.2) / (tf + 1.2));
	}
	return score;
}

function vectorScore(query: string, doc: string): number {
	const a = tokens(query);
	const b = new Set(tokens(doc));
	const overlap = a.filter((x) => b.has(x)).length;
	return overlap / Math.sqrt(Math.max(1, a.length) * Math.max(1, b.size));
}

function hybridRetrieve(queries: string[], k: number): Chunk[] {
	// Merge both result lists with Reciprocal Rank Fusion (RRF)
	const fused = new Map<string, number>();
	for (const q of queries) {
		for (const scorer of [keywordScore, vectorScore]) {
			const ranked = [...LIBRARY].sort((x, y) => scorer(q, y.text) - scorer(q, x.text));
			ranked.forEach((c, rank) => fused.set(c.id, (fused.get(c.id) ?? 0) + 1 / (60 + rank)));
		}
	}
	return [...LIBRARY].sort((x, y) => fused.get(y.id)! - fused.get(x.id)!).slice(0, k);
}

// ---- 4. Dedupe: keep only the latest version per topic ----------------------
function dedupeLatest(chunks: Chunk[]): Chunk[] {
	const latest = new Map<string, Chunk>();
	for (const c of chunks) {
		const prev = latest.get(c.topic);
		if (!prev || c.updatedAt > prev.updatedAt) latest.set(c.topic, c);
	}
	return chunks.filter((c) => latest.get(c.topic) === c);
}

// ---- 5. One Noul per candidate ----------------------------------------------
interface Candidate {
	id: string;
	chunk: Chunk;
}

const questionId = (c: Candidate) => `${c.id}_answers_query`;

function buildRequest(query: string, batch: Candidate[]): SystemOneRequest {
	return {
		model: "jev-latest",
		state: { query, candidates: batch.map((c) => ({ id: c.id, content: c.chunk.text })) },
		questions: Object.fromEntries(
			batch.map((c) => [
				questionId(c),
				{
					type: "noul",
					instructions: `Does the \`content\` of the item in \`candidates\` whose \`id\` is "${c.id}" contain information that directly answers \`query\`?`,
				},
			]),
		),
	};
}

// ---- Generation + citation check (generative model is stubbed) --------------
function generateAnswer(query: string, kept: Candidate[]): { text: string; citations: string[] } {
	const top = kept[0]!;
	return { text: `${top.chunk.text.replace(/\.$/, "")} [${top.id}]`, citations: [top.id] };
}

printMode();
const query = "How long does it take to get my refund?";
section(`Query: ${query}`);
const queries = rewriteQuery(query);
console.log("Rewritten queries:", queries);

const recalled = hybridRetrieve(queries, TOP_K);
console.log("Recalled:", recalled.map((c) => c.id));
const deduped = dedupeLatest(recalled);
console.log("After dedupe:", deduped.map((c) => `${c.id}(${c.updatedAt})`));

const candidates: Candidate[] = deduped.map((chunk, i) => ({ id: `candidate_${i + 1}`, chunk }));
const scored: Array<Candidate & { p: number }> = [];
for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
	const batch = candidates.slice(i, i + BATCH_SIZE);
	const req = buildRequest(query, batch);
	try {
		const res = await systemOne(req);
		for (const c of batch) scored.push({ ...c, p: getNoul(res, req, questionId(c)) });
	} catch (err) {
		// Candidates whose judgment failed are not scored
		if (!(err instanceof JevUnavailableError)) throw err;
		console.log(`Batch ${i / BATCH_SIZE} failed, skipping: ${err.message}`);
	}
}

section("Jev verdicts + code sorting/filtering");
scored.sort((a, b) => b.p - a.p);
for (const c of scored) {
	console.log(`${(c.p >= KEEP_THRESHOLD ? "keep" : "drop").padEnd(5)} ${c.id.padEnd(12)} p ${pct(c.p).padEnd(6)} [${c.chunk.source}] ${c.chunk.text}`);
}
const kept = scored.filter((c) => c.p >= KEEP_THRESHOLD);

section("Answer");
if (!kept.length) {
	console.log("No relevant material found (generative model not called)");
} else {
	const answer = generateAnswer(query, kept);
	const keptIds = new Set(kept.map((c) => c.id));
	const valid = answer.citations.length > 0 && answer.citations.every((id) => keptIds.has(id));
	console.log(valid ? answer.text : "Citation check failed: the answer cites a passage that was not kept; not shown, escalating to a human");
	for (const id of answer.citations) {
		const c = kept.find((k) => k.id === id);
		if (c) console.log(`  [${id}] source: ${c.chunk.source} (${c.chunk.id}, updated ${c.chunk.updatedAt})`);
	}
}
audit("rag.filter", { query, threshold: KEEP_THRESHOLD, scores: scored.map((c) => ({ id: c.chunk.id, p: c.p })), kept: kept.map((c) => c.chunk.id) });
