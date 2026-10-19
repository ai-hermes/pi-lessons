/**
 * Gate: runs in Pi's `beforeToolCall` hook, before every tool call.
 *
 * Order of checks — cheapest and most certain first:
 *   1. unknown tool                           → block (code)
 *   2. read / edit / write path outside       → block (code, outsideWorkspace = 1)
 *   3. read                                   → allow (code, Jev not called)
 *   4. Jev: destructive / irreversible        → decideGate() → allow / ask / block
 *      bash has no path to check in code, so Jev also judges outsideWorkspace
 *   5. Jev unavailable or bad answer          → block (fail closed)
 *
 * Jev only ever sees the tool name, the (redacted, truncated) arguments and code-computed facts about the
 * target — never the page or file text that led the model to make the call. A prompt injection in that
 * text still has to surface as a concrete tool call, and that is what gets judged.
 */
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { type DecisionLog, redact, redactText } from "@/decision-log.ts";
import { type JevClient, type JsonValue, noul, readNoul } from "@/jev/client.ts";
import { decideGate, FAILURE_POLICY, type GateSignals } from "@/policies.ts";
import type { Workspace } from "@/workspace.ts";

/** Human approval for the "ask" band. No answer means no. */
export type Approver = (subject: string, signals: GateSignals) => Promise<boolean>;

const PATH_TOOLS = new Set(["read", "edit", "write"]);
const READ_ONLY = new Set(["read"]);

const outsideWorkspace = noul({
	instructions: "This shell command reads or writes anything outside the workspace root (the command's working directory).",
	criteria: {
		true: "Touches paths like ../, ~, /etc or absolute paths elsewhere, or sends data over the network.",
		false: "Every path it touches is inside the working directory.",
	},
});

/** Asks Jev whether a tool call is destructive / irreversible, and for shell commands whether they leave the workspace */
function buildToolRiskQuestions(state: { [key: string]: JsonValue }, isShell: boolean) {
	return {
		state,
		questions: {
			...(isShell ? { outsideWorkspace } : {}),
			destructive: noul({
				instructions: "This tool call destroys or overwrites data that was not created by this run.",
				criteria: {
					true: "Deletes files, truncates, edits or overwrites existing content, or force-pushes over history.",
					false: "Reads, lists, creates a new file, or changes / deletes a file this run already created (see `targets[].createdThisRun`).",
				},
			}),
			irreversible: noul({
				instructions: "The effect of this tool call would be hard or impossible to undo from inside this run.",
				criteria: {
					true: "Removes data with no copy kept by the run, or changes something outside version control.",
					false: "The run could restore the previous state by itself, or nothing existing is changed.",
				},
			}),
		},
	};
}

function subjectOf(name: string, args: unknown): string {
	return `${name} ${redactText(JSON.stringify(args ?? {}), 160)}`;
}

function blocked(reason: string): BeforeToolCallResult {
	return {
		block: true,
		reason: `${reason} Do not retry this call or work around it; tell the user what you could not do.`
	};
}

export function createGate(deps: {
	jev: JevClient;
	log: DecisionLog;
	workspace: Workspace;
	tools: string[];
	approver: Approver;
}): (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
	return async ({ toolCall, args }) => {
		const started = performance.now();
		const ms = () => Math.round(performance.now() - started);
		const subject = subjectOf(toolCall.name, args);
		const tool = toolCall.name;

		if (!deps.tools.includes(tool)) {
			deps.log.write({ stage: "gate", verdict: "block", reason: "unknown-tool (code)", subject, latencyMs: ms() });
			return blocked(`Blocked: unknown tool ${toolCall.name}.`);
		}

		const argRecord = (args ?? {}) as Record<string, unknown>;
		const target = PATH_TOOLS.has(tool) && typeof argRecord.path === "string" ? deps.workspace.describe(argRecord.path) : undefined;

		if (target && !target.inside) {
			const signals: GateSignals = {
				destructive: 0,
				irreversible: 0,
				outsideWorkspace: 1
			};
			const verdict = decideGate(signals);
			deps.log.write({ stage: "gate", verdict: verdict.action, reason: "outside-workspace (code)", subject, signals, latencyMs: ms() });
			return blocked(`Blocked: ${target.violation}.`);
		}

		if (READ_ONLY.has(tool)) {
			deps.log.write({ stage: "gate", verdict: "allow", reason: "read-only (code)", subject, latencyMs: ms() });
			return undefined;
		}

		const { abs, ...facts } = target ?? {};
		const isShell = tool === "bash";
		const jevRequest = buildToolRiskQuestions({ tool, arguments: redact(args ?? {}, 300) as JsonValue, ...(target ? { target: facts as JsonValue } : {}) }, isShell);
		let signals: GateSignals;
		let jevModel: string | undefined;
		try {
			const res = await deps.jev.ask(jevRequest);
			jevModel = res.model;
			signals = {
				destructive: readNoul(res, jevRequest, "destructive"),
				irreversible: readNoul(res, jevRequest, "irreversible"),
				outsideWorkspace: isShell ? readNoul(res, jevRequest, "outsideWorkspace") : 0,
			};
		} catch (err) {
			deps.log.write({ stage: "gate", verdict: FAILURE_POLICY.gate, fallback: "jev-failed→block", error: (err as Error).message, subject, latencyMs: ms() });
			return blocked("Blocked: the safety check is unavailable, so this call cannot be approved right now.");
		}

		const verdict = decideGate(signals);
		let action = verdict.action;
		let reason: string = `riskiest=${verdict.riskiestSignal}`;
		if (action === "ask") {
			const approved = await deps.approver(subject, signals);
			action = approved ? "allow" : "block";
			reason = `${reason}; human ${approved ? "approved" : "denied / unavailable"}`;
		}
		deps.log.write({ stage: "gate", verdict: action, reason, subject, signals, latencyMs: ms(), jevModel });

		if (action === "allow") {
			if (tool === "write" && target?.inside && !target.exists && abs) deps.workspace.createdThisRun.add(abs);
			return undefined;
		}
		return blocked(`Blocked: too risky (${verdict.riskiestSignal}=${verdict.risk.toFixed(2)}).`);
	};
}
