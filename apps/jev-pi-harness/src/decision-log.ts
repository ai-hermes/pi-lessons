/**
 * decisions.jsonl — one redacted JSON object per decision.
 *
 * Gate sees every tool argument, so anything written here (or sent to Jev) goes through `redact` first:
 * e-mails, API keys / bearer tokens / credential assignments are masked and long strings are truncated.
 */
import { appendFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";

export type Stage = "router" | "gate" | "verifier";

export interface DecisionRecord {
	stage: Stage;
	verdict: string;
	subject: string;
	signals?: Record<string, number>;
	/** Set when Jev failed and the stage applied its failure policy */
	fallback?: string;
	error?: string;
	reason?: string;
	latencyMs: number;
	jevModel?: string;
	runId: string;
	at: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
	[/\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g, "[secret]"],
	[/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [secret]"],
	[/\b(api[_-]?key|token|secret|password|passwd)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[secret]"],
];

export const MAX_FIELD_CHARS = 400;

export function redactText(text: string, max = MAX_FIELD_CHARS): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out.length > max ? `${out.slice(0, max)}…[+${out.length - max} chars]` : out;
}

/** Deep-redacts any JSON-ish value; strings are masked and truncated individually. */
export function redact(value: unknown, max = MAX_FIELD_CHARS): unknown {
	if (typeof value === "string") return redactText(value, max);
	if (Array.isArray(value)) return value.map((v) => redact(v, max));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, max)]));
	}
	return value;
}

export class DecisionLog {
	readonly records: DecisionRecord[] = [];

	constructor(
		readonly runId: string,
		private readonly file?: string,
		private readonly echo: (record: DecisionRecord) => void = () => {},
	) {
		if (file && !existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
		if (file) chmodSync(file, 0o600);
	}

	write(entry: Omit<DecisionRecord, "runId" | "at">): DecisionRecord {
		const record: DecisionRecord = {
			...entry,
			subject: redactText(entry.subject, 200),
			...(entry.error ? { error: redactText(entry.error, 200) } : {}),
			runId: this.runId,
			at: new Date().toISOString(),
		};
		this.records.push(record);
		if (this.file) appendFileSync(this.file, `${JSON.stringify(record)}\n`);
		this.echo(record);
		return record;
	}
}
