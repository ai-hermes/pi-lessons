/**
 * Case 3: Writing quality check (Noul + Choice)
 *
 * Each check is an independent question with its own verdict; no aggregate score, and Jev never rewrites.
 * Division of labor: verifiable rules → code; semantic dimensions → Jev; suggested edits → generative model or a human.
 */
import {
	getChoice,
	getNoul,
	formatPercent,
	printJson,
	printMode,
	section,
	choice,
	noul,
	systemOne,
	type ChoiceQuestion,
	type NoulQuestion,
} from "./shared/jev.ts";

// Clarity Judge default, tunable; changing the threshold only recomputes locally and does not call Jev again
const CONFIDENCE_THRESHOLD = Number(process.env.CLARITY_THRESHOLD ?? 0.7);

const input = {
	audience: "project lead",
	context: "weekly report",
	body: "I think this plan might have some issues, basically. If everyone has some time, maybe take a look, and we can kind of chat about it later.",
};

// ---- 2. Run verifiable rules in code first ---------------------------------
const BANNED_WORDS = ["synergy", "leverage", "circle back"];
const DASH_PATTERN = /—|--/g;

/** Checks that plain code can do reliably (length, banned words, dashes, date, owner); Jev handles the rest */
function runCodeChecks(text: string) {
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

// ---- 3. One question per check; code declares which answer counts as an issue ----
type Check =
	| { id: string; question: NoulQuestion; issueWhen: boolean }
	| { id: string; question: ChoiceQuestion; issueOptions: string[] };

/** The judgment checks sent to Jev, one question each */
function buildJevChecks(): Check[] {
	return [
		{
			id: "hedging",
			issueWhen: true,
			question: noul("Does `body` unnecessarily weaken its points with phrases like \"might\", \"maybe\", or \"I think\"?", {
				true: "Points that could be stated directly are softened by qualifiers that add no information",
				false: "Points are stated directly, or the qualifiers reflect genuine uncertainty",
			}),
		},
		{
			id: "filler",
			issueWhen: true,
			question: noul("Does `body` contain filler or redundant phrasing that could be removed without changing the meaning?", {
				true: "There are phrases that could be deleted outright without losing any information",
				false: "Every sentence carries information",
			}),
		},
		{
			id: "tone",
			issueOptions: ["mixed"],
			question: choice("What is the overall tone of `body`?", {
				formal: "Formal, professional tone throughout",
				casual: "Relaxed, conversational tone throughout",
				mixed: "Formal and casual phrasing are mixed, so the tone is inconsistent",
			}),
		},
		{
			id: "actionability",
			issueOptions: ["vague_next_step", "no_next_step"],
			question: choice("How clearly does `body` tell the reader what to do next?", {
				clear_next_step: "States a concrete action, an owner, or a deadline",
				vague_next_step: "Mentions that something should be done, but with no concrete action, owner, or deadline",
				no_next_step: "Only describes the situation and makes no request",
			}),
		},
	];
}

function buildRequest(text: string, jevChecks: Check[]) {
	return {
		model: "jev-latest",
		state: {
			audience: input.audience,
			context: input.context,
			body: text
		},
		questions: Object.fromEntries(jevChecks.map((c) => [c.id, c.question])),
	};
}

// ---- After the answers: map each check to pass / issue / needs review ----
printMode();
const text = input.body;
section("Body");
console.log(text);

section("Code rules");
printJson("rules", runCodeChecks(text));

const jevChecks = buildJevChecks();
const req = buildRequest(text, jevChecks);
const res = await systemOne(req);

section("Jev check results");
for (const check of jevChecks) {
	let issue: boolean;
	let confidence: number;
	let detail: string;
	if ("issueWhen" in check) {
		const p = getNoul(res, req, check.id);
		const answer = p >= 0.5;
		/*
		if p >= 0.5, answer is yes
		if p < 0.5, answer is no then answer yes will be 1 - p
		here we need to calculate the p for yes, so it will be max(p, 1-p)
		*/
		confidence = Math.max(p, 1 - p);
		issue = answer === check.issueWhen;
		detail = `P(yes) ${formatPercent(p)}`;
	} else {
		const a = getChoice(res, req, check.id);
		confidence = a.confidence;
		issue = check.issueOptions.includes(a.choice);
		detail = `${a.choice}`;
	}
	const status = confidence < CONFIDENCE_THRESHOLD ?
		"review" :
		issue ? "issue" : "pass";
	console.log(
		`${status === "pass" ? "✅" : status === "issue" ? "❌" : "❓"} ${check.id.padEnd(14)} ${status.padEnd(7)} ${detail}  confidence ${formatPercent(confidence)}`,
	);
}

console.log("\nNext step: for suggested edits, pass the check results above to a generative model or a human; Jev does not rewrite.");
