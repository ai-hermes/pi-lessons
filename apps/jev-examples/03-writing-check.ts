/**
 * Case 3: Writing quality check (Noul + Choice)
 *
 * Each check is an independent question with its own verdict; no aggregate score, and Jev never rewrites.
 * Division of labor: verifiable rules → code; semantic dimensions → Jev; suggested edits → generative model or a human.
 */
import {
	audit,
	getChoice,
	getNoul,
	pct,
	printJson,
	printMode,
	section,
	systemOne,
	type ChoiceQuestion,
	type NoulQuestion,
	type SystemOneRequest,
} from "./shared/jev.ts";

// Clarity Judge default, tunable; changing the threshold only recomputes locally and does not call Jev again
const CONFIDENCE_THRESHOLD = Number(process.env.CLARITY_THRESHOLD ?? 0.7);
const FORMAL_AUDIENCES = ["project lead", "client", "management"];

const input = {
	audience: "project lead",
	context: "weekly report",
	raw: [
		"I think this plan might have some issues, basically. If everyone has some time, maybe take a look, and we can kind of chat about it later.",
		"",
		"> On 2026-10-10 you wrote:",
		"> Let's put last week's plan on hold",
		"",
		"```",
		"SELECT * FROM plans;",
		"```",
		"--",
		"John Smith | Backend Team",
	].join("\n"),
};

// ---- 2. Clean the text: strip quotes, code blocks, and signature ------------
function cleanText(raw: string): string {
	const out: string[] = [];
	let inCode = false;
	for (const line of raw.split("\n")) {
		if (line.startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		if (inCode || line.startsWith(">")) continue;
		if (line.trim() === "--") break; // drop everything after the signature separator
		out.push(line);
	}
	return out.join("\n").trim();
}

// ---- 3. Run verifiable rules in code first ---------------------------------
const BANNED_WORDS = ["synergy", "leverage", "circle back"];
const DASH_PATTERN = /—|--/g;

function codeRules(text: string) {
	const lower = text.toLowerCase();
	const banned = BANNED_WORDS.filter((w) => lower.includes(w));
	const dashes = (text.match(DASH_PATTERN) ?? []).length;
	return {
		length: { value: text.length, issue: text.length > 800 },
		banned_words: { value: banned, issue: banned.length > 0 },
		dash_count: { value: dashes, issue: dashes > 2 },
		has_date: {
			value: /\d{4}-\d{2}-\d{2}|\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i.test(text),
		},
		has_owner: { value: /@\S+|\bowner:/i.test(text) },
	};
}

// ---- 4. One question per check; code declares which answer counts as an issue ----
type Check =
	| { id: string; question: NoulQuestion; issueWhen: boolean; keywords: string[] }
	| { id: string; question: ChoiceQuestion; issueOptions: string[]; keywords: string[] };

function checks(audience: string): Check[] {
	return [
		{
			id: "hedging",
			issueWhen: true,
			keywords: ["might", "maybe", "perhaps", "some", "i think", "kind of", "sort of", "probably"],
			question: {
				type: "noul",
				instructions: "Does `body` unnecessarily weaken its points with phrases like \"might\", \"maybe\", or \"I think\"?",
				criteria: {
					true: "Points that could be stated directly are softened by qualifiers that add no information",
					false: "Points are stated directly, or the qualifiers reflect genuine uncertainty",
				},
			},
		},
		{
			id: "filler",
			issueWhen: true,
			keywords: ["basically", "kind of", "sort of", "actually", "just", "really"],
			question: {
				type: "noul",
				instructions: "Does `body` contain filler or redundant phrasing that could be removed without changing the meaning?",
				criteria: {
					true: "There are phrases that could be deleted outright without losing any information",
					false: "Every sentence carries information",
				},
			},
		},
		{
			id: "tone",
			// Whether "casual" is acceptable is decided in code based on the audience
			issueOptions: FORMAL_AUDIENCES.includes(audience) ? ["mixed", "casual"] : ["mixed"],
			keywords: ["everyone", "chat", "kind of", "take a look", "hey"],
			question: {
				type: "choice",
				instructions: "What is the overall tone of `body`?",
				criteria: {
					formal: "Formal, professional tone throughout",
					casual: "Relaxed, conversational tone throughout",
					mixed: "Formal and casual phrasing are mixed, so the tone is inconsistent",
				},
			},
		},
		{
			id: "actionability",
			issueOptions: ["vague_next_step", "no_next_step"],
			keywords: ["take a look", "chat", "later", "discuss", "follow up"],
			question: {
				type: "choice",
				instructions: "How clearly does `body` tell the reader what to do next?",
				criteria: {
					clear_next_step: "States a concrete action, an owner, or a deadline",
					vague_next_step: "Mentions that something should be done, but with no concrete action, owner, or deadline",
					no_next_step: "Only describes the situation and makes no request",
				},
			},
		},
	];
}

function buildRequest(text: string, list: Check[]): SystemOneRequest {
	return {
		model: "jev-latest",
		state: { audience: input.audience, context: input.context, body: text },
		questions: Object.fromEntries(list.map((c) => [c.id, c.question])),
	};
}

// ---- After the answers: map to pass / issue / needs review; evidence sentence is approximated by code ----
function locateEvidence(text: string, keywords: string[]): string | null {
	const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
	const scored = sentences.map((s) => {
		const lower = s.toLowerCase();
		return { s, hits: keywords.filter((k) => new RegExp(`\\b${k}\\b`).test(lower)).length };
	});
	const best = scored.sort((a, b) => b.hits - a.hits)[0];
	return best && best.hits > 0 ? best.s : null;
}

printMode();
const text = cleanText(input.raw);
section("Cleaned body");
console.log(text);

section("Code rules");
printJson("rules", codeRules(text));

const list = checks(input.audience);
const req = buildRequest(text, list);
const res = await systemOne(req);

section("Jev check results");
const results = list.map((check) => {
	let issue: boolean;
	let confidence: number;
	let detail: string;
	if ("issueWhen" in check) {
		const p = getNoul(res, req, check.id);
		const answer = p >= 0.5;
		confidence = Math.max(p, 1 - p);
		issue = answer === check.issueWhen;
		detail = `P(yes) ${pct(p)}`;
	} else {
		const a = getChoice(res, req, check.id);
		confidence = a.confidence;
		issue = check.issueOptions.includes(a.choice);
		detail = `${a.choice}`;
	}
	const status = confidence < CONFIDENCE_THRESHOLD ? "review" : issue ? "issue" : "pass";
	const evidence = issue ? locateEvidence(text, check.keywords) : null;
	console.log(
		`${status === "pass" ? "✅" : status === "issue" ? "❌" : "❓"} ${check.id.padEnd(14)} ${status.padEnd(7)} ${detail}  confidence ${pct(confidence)}` +
			(evidence ? `\n   Approximate location (keyword match, not Jev output): "${evidence}"` : ""),
	);
	return { id: check.id, status, confidence, issue };
});

audit("writing.check", { model: res.model, threshold: CONFIDENCE_THRESHOLD, results });
console.log("\nNext step: for suggested edits, pass the check results above to a generative model or a human; Jev does not rewrite.");
