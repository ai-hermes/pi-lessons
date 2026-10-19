/**
 * decisions.jsonl: one redacted JSON object per decision.
 * `redact` is also applied to anything sent to Jev, not only to what is logged.
 */
import { appendFileSync } from "node:fs";

export interface DecisionRecord {
	stage: "router" | "gate" | "verifier";
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

const SECRETS: Array<[RegExp, string]> = [
	[/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]"],
	[/\b(?:sk|ghp|github_pat)[-_][\w-]{8,}/g, "[secret]"],
	[/\bBearer\s+\S+/gi, "Bearer [secret]"],
	[/\b(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[secret]"],
];

export function redactText(text: string, max = 400): string {
	const out = SECRETS.reduce((s, [re, to]) => s.replace(re, to), text);
	return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function redact(value: unknown, max = 400): unknown {
	if (typeof value === "string") return redactText(value, max);
	if (Array.isArray(value)) return value.map((v) => redact(v, max));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, max)]));
	return value;
}

export class DecisionLog {
	readonly records: DecisionRecord[] = [];

	constructor(
		readonly runId: string,
		private readonly file: string,
		private readonly echo: (record: DecisionRecord) => void,
	) { }

	write(entry: Omit<DecisionRecord, "runId" | "at">): void {
		const record = {
			...entry,
			subject: redactText(entry.subject, 200),
			runId: this.runId,
			at: new Date().toISOString()
		};
		this.records.push(record);
		appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		this.echo(record);
	}
}
