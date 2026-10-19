/**
 * Human approval for calls in the Gate's "ask" band.
 *
 * Without a reachable human (CI, piped stdin) or after the timeout, the answer is "no": an unanswered
 * approval must never turn into an implicit allow.
 */
import { createInterface } from "node:readline/promises";
import type { GateSignals, GateVerdict } from "./policies.ts";

export type Approver = (req: { subject: string; verdict: GateVerdict; signals: GateSignals }) => Promise<boolean>;

export const denyAll: Approver = async () => false;
export const approveAll: Approver = async () => true;

export function ttyApprover(timeoutMs = 60_000): Approver {
	if (!process.stdin.isTTY) return denyAll;
	return async ({ subject, verdict, signals }) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
			const answer = await rl.question(
				`\n⚠️  Approval needed: ${subject}\n   destructive ${pct(signals.destructive)} · irreversible ${pct(signals.irreversible)} · worst=${verdict.driver}\n   Allow? [y/N] (${timeoutMs / 1000}s) `,
				{ signal },
			);
			return /^y(es)?$/i.test(answer.trim());
		} catch {
			console.log("\n   (no answer, denied)");
			return false;
		} finally {
			rl.close();
		}
	};
}
