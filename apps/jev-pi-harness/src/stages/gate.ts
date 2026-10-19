/**
 * Gate: runs in Pi's `beforeToolCall` hook, before every tool call.
 *
 * Order of checks — cheapest and most certain first:
 *   1. unknown tool                     → block (code)
 *   2. path argument outside workspace  → block (code, outsideWorkspace = 1)
 *   3. read-only tool                   → allow (code, Jev not called)
 *   4. Jev: destructive / irreversible  → decideGate() → allow / ask / block
 *   5. Jev unavailable or bad answer    → block (fail closed)
 *
 * Jev only ever sees the tool name, the (redacted, truncated) arguments and code-computed facts about the
 * target — never the page or file text that led the model to make the call. A prompt injection in that
 * text still has to surface as a concrete tool call, and that is what gets judged.
 */
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { type DecisionLog, redact, redactText } from "@/decision-log.ts";
import { type JevClient, type JsonValue, noul, readNoul } from "@/jev/client.ts";
import { decideGate, FAILURE_POLICY, type GateSignals } from "@/policies.ts";
import type { HarnessTool, Workspace } from "@/workspace.ts";

/** Human approval for the "ask" band. No answer means no. */
export type Approver = (subject: string, signals: GateSignals) => Promise<boolean>;

export function gateRequest(state: { [key: string]: JsonValue }) {
	return {
		state,
		questions: {
			destructive: noul({
				instructions: "This tool call destroys or overwrites data that was not created by this run.",
				criteria: {
					true: "Deletes files, truncates or overwrites existing content, or force-pushes over history.",
					false: "Reads, lists, creates a new file, or overwrites / deletes a file this run already created (see `targets[].createdThisRun`).",
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
	return { block: true, reason: `${reason} Do not retry this call or work around it; tell the user what you could not do.` };
}

export function createGate(deps: {
	jev: JevClient;
	log: DecisionLog;
	workspace: Workspace;
	tools: HarnessTool[];
	approver: Approver;
}): (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
	return async ({ toolCall, args }) => {
		const started = performance.now();
		const ms = () => Math.round(performance.now() - started);
		const subject = subjectOf(toolCall.name, args);
		const tool = deps.tools.find((t) => t.name === toolCall.name);

		if (!tool) {
			deps.log.write({ stage: "gate", verdict: "block", reason: "unknown-tool (code)", subject, latencyMs: ms() });
			return blocked(`Blocked: unknown tool ${toolCall.name}.`);
		}

		const argRecord = (args ?? {}) as Record<string, unknown>;
		const targets = tool.pathArgs
			.filter((k) => typeof argRecord[k] === "string")
			.map((k) => ({ arg: k, path: argRecord[k] as string, ...deps.workspace.describe(argRecord[k] as string) }));

		const violation = targets.find((t) => !t.inside);
		if (violation) {
			const signals: GateSignals = { destructive: 0, irreversible: 0, outsideWorkspace: 1 };
			const verdict = decideGate(signals);
			deps.log.write({ stage: "gate", verdict: verdict.action, reason: "outside-workspace (code)", subject, signals: { ...signals }, latencyMs: ms() });
			return blocked(`Blocked: ${violation.violation}.`);
		}

		if (tool.readOnly) {
			deps.log.write({ stage: "gate", verdict: "allow", reason: "read-only (code)", subject, latencyMs: ms() });
			return undefined;
		}

		const req = gateRequest({ tool: toolCall.name, arguments: redact(args ?? {}, 300) as JsonValue, targets: JSON.parse(JSON.stringify(targets)) as JsonValue });
		let signals: GateSignals;
		let jevModel: string | undefined;
		try {
			const res = await deps.jev.ask(req);
			jevModel = res.model;
			signals = { destructive: readNoul(res, req, "destructive"), irreversible: readNoul(res, req, "irreversible"), outsideWorkspace: 0 };
		} catch (err) {
			deps.log.write({ stage: "gate", verdict: FAILURE_POLICY.gate, fallback: "jev-failed→block", error: (err as Error).message, subject, latencyMs: ms() });
			return blocked("Blocked: the safety check is unavailable, so this call cannot be approved right now.");
		}

		const verdict = decideGate(signals);
		let action = verdict.action;
		let reason: string = `worst=${verdict.driver}`;
		if (action === "ask") {
			const approved = await deps.approver(subject, signals);
			action = approved ? "allow" : "block";
			reason = `${reason}; human ${approved ? "approved" : "denied / unavailable"}`;
		}
		deps.log.write({ stage: "gate", verdict: action, reason, subject, signals: { ...signals }, latencyMs: ms(), jevModel });

		if (action === "allow") return undefined;
		return blocked(`Blocked: this looks destructive (${verdict.driver}=${verdict.worst.toFixed(2)}).`);
	};
}
