/**
 * 案例 3：写作质量检查（Noul + Choice）
 *
 * 每个检查是一个独立问题，各自给出结论；不合成总分，不让 Jev 改写。
 * 分工：可验证规则 → 代码；语义维度 → Jev；修改建议 → 生成模型或人工。
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

// Clarity Judge 默认值，可调；调整阈值只在本地重算，不会再次调用 Jev
const CONFIDENCE_THRESHOLD = Number(process.env.CLARITY_THRESHOLD ?? 0.7);
const FORMAL_AUDIENCES = ["项目负责人", "客户", "管理层"];

const input = {
	audience: "项目负责人",
	scene: "周报",
	raw: [
		"这个方案可能有些问题。大家有空的话看看，之后我们再讨论一下。",
		"",
		"> 在 2026-10-10 的邮件中写道：",
		"> 上周的方案先放一放",
		"",
		"```",
		"SELECT * FROM plans;",
		"```",
		"--",
		"张三 | 后端组",
	].join("\n"),
};

// ---- 2. 清理文本：去掉引用、代码块、签名 ------------------------------------
function cleanText(raw: string): string {
	const out: string[] = [];
	let inCode = false;
	for (const line of raw.split("\n")) {
		if (line.startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		if (inCode || line.startsWith(">")) continue;
		if (line.trim() === "--") break; // 签名分隔符之后全部丢弃
		out.push(line);
	}
	return out.join("\n").trim();
}

// ---- 3. 代码先跑可验证的规则 -----------------------------------------------
const BANNED_WORDS = ["赋能", "抓手", "闭环"];

function codeRules(text: string) {
	return {
		length: { value: text.length, issue: text.length > 800 },
		banned_words: { value: BANNED_WORDS.filter((w) => text.includes(w)), issue: BANNED_WORDS.some((w) => text.includes(w)) },
		dash_count: { value: (text.match(/——|—|--/g) ?? []).length, issue: (text.match(/——|—|--/g) ?? []).length > 2 },
		has_date: { value: /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{2}-\d{2}|周[一二三四五六日]/.test(text) },
		has_owner: { value: /@\S+|负责人[:：]/.test(text) },
	};
}

// ---- 4. 每个检查一个问题，并在代码里声明“哪个答案算问题” -------------------
type Check =
	| { id: string; question: NoulQuestion; issueWhen: boolean; keywords: string[] }
	| { id: string; question: ChoiceQuestion; issueOptions: string[]; keywords: string[] };

function checks(audience: string): Check[] {
	return [
		{
			id: "hedging",
			issueWhen: true,
			keywords: ["可能", "有些", "大概", "也许", "似乎", "或许"],
			question: {
				type: "noul",
				instructions: "`text` 是否用“可能”“有些”“大概”之类的说法，不必要地弱化了观点？",
				criteria: {
					true: "本可以直接陈述的观点被修饰语弱化，这些修饰语没有提供额外信息",
					false: "观点陈述直接，或修饰语反映了真实存在的不确定性",
				},
			},
		},
		{
			id: "filler",
			issueWhen: true,
			keywords: ["一下", "的话", "其实", "基本上", "总的来说"],
			question: {
				type: "noul",
				instructions: "`text` 是否包含删掉也不影响意思的套话或重复表达？",
				criteria: { true: "存在可以直接删除、不损失任何信息的说法", false: "每句话都在传递信息" },
			},
		},
		{
			id: "tone",
			// 是否接受 casual 由代码按 audience 决定
			issueOptions: FORMAL_AUDIENCES.includes(audience) ? ["mixed", "casual"] : ["mixed"],
			keywords: ["大家", "有空", "哈", "啦"],
			question: {
				type: "choice",
				instructions: "`text` 的整体语气是什么？",
				criteria: {
					formal: "通篇是正式、专业的语气",
					casual: "通篇是轻松、口语化的语气",
					mixed: "正式和随意的说法混在一起，语气不一致",
				},
			},
		},
		{
			id: "actionability",
			issueOptions: ["vague_next_steps", "no_next_steps"],
			keywords: ["看看", "讨论", "之后", "再", "跟进"],
			question: {
				type: "choice",
				instructions: "`text` 对读者接下来要做什么，说得有多清楚？",
				criteria: {
					clear_next_steps: "写明了具体动作、负责人或截止时间",
					vague_next_steps: "提到要做事，但没有具体动作、负责人或时间",
					no_next_steps: "只描述情况，没有提出任何要求",
				},
			},
		},
	];
}

function buildRequest(text: string, list: Check[]): SystemOneRequest {
	return {
		model: "jev-latest",
		state: { audience: input.audience, scene: input.scene, text },
		questions: Object.fromEntries(list.map((c) => [c.id, c.question])),
	};
}

// ---- 拿到答案之后：换算成“通过 / 有问题 / 需复核”，证据句由代码近似定位 ----
function locateEvidence(text: string, keywords: string[]): string | null {
	const sentences = text.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
	const scored = sentences.map((s) => ({ s, hits: keywords.filter((k) => s.includes(k)).length }));
	const best = scored.sort((a, b) => b.hits - a.hits)[0];
	return best && best.hits > 0 ? best.s : null;
}

printMode();
const text = cleanText(input.raw);
section("清理后的正文");
console.log(text);

section("代码规则");
printJson("rules", codeRules(text));

const list = checks(input.audience);
const req = buildRequest(text, list);
const res = await systemOne(req);

section("Jev 检查结果");
const results = list.map((check) => {
	let issue: boolean;
	let confidence: number;
	let detail: string;
	if ("issueWhen" in check) {
		const p = getNoul(res, req, check.id);
		const answer = p >= 0.5;
		confidence = Math.max(p, 1 - p);
		issue = answer === check.issueWhen;
		detail = `p(yes)=${pct(p)}`;
	} else {
		const a = getChoice(res, req, check.id);
		confidence = a.confidence;
		issue = check.issueOptions.includes(a.choice);
		detail = `${a.choice}`;
	}
	const status = confidence < CONFIDENCE_THRESHOLD ? "需复核" : issue ? "有问题" : "通过";
	const evidence = issue ? locateEvidence(text, check.keywords) : null;
	console.log(
		`${status === "通过" ? "✅" : status === "有问题" ? "❌" : "❓"} ${check.id.padEnd(14)} ${status}  ${detail}  confidence=${pct(confidence)}` +
			(evidence ? `\n   近似定位（关键词匹配，非 Jev 输出）：「${evidence}」` : ""),
	);
	return { id: check.id, status, confidence, issue };
});

audit("writing.check", { model: res.model, threshold: CONFIDENCE_THRESHOLD, results });
console.log("\n下一步：如需修改建议，把以上检查结果作为输入交给生成模型或人工；Jev 不负责改写。");
