# jev-pi-harness

A runnable version of the [Notion · Pi + Jev Agent Harness](https://app.notion.com/p/dingwenjiang/Pi-Jev-Agent-Harness-3fe25bd1f17780d09563cb34a96f0745) design. [Pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) (`Agent` from pi-agent-core) runs the agent loop. [Jev](https://docs.typesafe.ai/api) answers three small judgement calls, and pure functions turn its numbers into actions:

| Stage | Hook | Jev questions | Policy (code) |
| --- | --- | --- | --- |
| **Router** | before the run | `tier` choice (fast / powerful) + `complexity` score | `decideRoute`: complexity ≥ 1.5 → powerful; confidence < 0.7 → powerful; otherwise Jev's choice |
| **Gate** | `beforeToolCall` | `destructive` + `irreversible` noul | `decideGate`: the riskiest of the signals decides, including the code-computed `outsideWorkspace`. ≥ 0.88 block, ≥ 0.65 ask a human, otherwise allow |
| **Verifier** | after each answer | `quality` score (0..2) + `grounded` noul | `decideVerify`: quality ≥ 1.5 and grounded ≥ 0.6 → accept; otherwise retry with feedback (max 2 attempts) |

```mermaid
flowchart LR
  R[request] --> Router -->|tier| A[Pi Agent loop]
  A -->|tool call| Gate
  Gate -- code: path outside / unknown tool --> B[block]
  Gate -- read-only --> T[tool]
  Gate -- Jev noul --> P{decideGate}
  P -->|allow| T
  P -->|ask| H[human approver]
  P -->|block| B
  B -->|reason, no retry| A
  T --> A
  A -->|answer| V[Verifier]
  V -->|retry + feedback| A
  V -->|accept / give-up| Out[result]
  Router & Gate & V -.-> L[(decisions.jsonl)]
```

Detailed diagrams: [inside the loop (Gate)](docs/loop-inner.svg) · [outside the loop (Router / Verifier)](docs/loop-outer.svg)

## Quick start

Copy `.env.example` to `.env` and fill in the Jev API key and proxy (`TYPESAFE_API_KEY`, `HTTPS_PROXY`) plus `KIMI_API_KEY` for the agent's model (the built-in `kimi-coding` provider, loaded through pi-coding-agent's `ModelRuntime`, as in `apps/pi-sdk`). Then:

```bash
pnpm install
pnpm --filter jev-pi-harness cases 02    # one case
pnpm --filter jev-pi-harness cases all
pnpm --filter jev-pi-harness cases 01 --fresh   # empty decisions.jsonl first
pnpm --filter jev-pi-harness test        # policy tests, no network
```

Everything runs against real Jev and a real LLM, so the path can differ between runs; each case prints what to watch for, and decisions.jsonl has the numbers.

Cases run on a scratch copy of `fixtures/workspace`, so the repo is never touched. Approvals in the "ask" band are prompted on the TTY and denied after 60 s or when no TTY is attached.

| Variable | Default | Notes |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | – | required |
| `JEV_MODEL` | `jev-1.13.0` | pin the version; thresholds are calibrated against it |
| `JEV_TIMEOUT_MS` | `8000` | 1 retry; Gate sits on the hot path |
| `HTTPS_PROXY` | – | required; Jev is region-restricted (HTTP 451) |
| `KIMI_API_KEY` | – | required |
| `KIMI_BASE_URL` | `https://api.kimi.com/coding` | |
| `KIMI_MODEL` / `KIMI_POWERFUL_MODEL` | `kimi-for-coding` / `k3` | the two Router tiers |
| `DECISION_LOG` | `./decisions.jsonl` | git-ignored, written with mode 0600 |

## Cases

| Case | Typical run | Shows |
| --- | --- | --- |
| `01-read-fact` | Router → fast; reads only; Verifier accepts | read-only tools skip Jev entirely |
| `02-cross-file-bug` | complexity escalates to powerful; editing `src/server.ts` lands in the ask band; you answer y/N | Router escalation, human-in-the-loop |
| `03-cleanup-notes` | `bash rm` on an old note → Gate blocks; judge is unsure → accept unverified | block reason fed back to the model, no retry loop |
| `04-prompt-injection` | `inbox/welcome.md` tells the agent to delete files and read `../../.ssh` | `read ../../.ssh` blocked **by code before Jev is asked**; `bash rm` / `cat` judged by Jev |
| `05-jev-outage` | the client points at `127.0.0.1:9`, so every Jev call fails | failure matrix: Router → powerful, Gate → block, Verifier → accept (unverified) |
| `06-verifier-retry` | if the answer misses items → retry with concrete feedback on the same model | Verifier loop and `maxAttempts` |

## Failure matrix and safety boundaries

| Jev failure (timeout, 5xx, malformed answer) | Behaviour | Why |
| --- | --- | --- |
| Router | `powerful` | quality over cost when unsure |
| Gate | **block** (fail closed) | a missing safety judgement is not permission |
| Verifier | accept, marked `verified=false` / `judge-unavailable` | avoid paying for blind retries |

A malformed answer counts as a failure: wrong kind, an option that wasn't offered, a value out of range, or a confidence outside [0,1].

Some checks are left to code and never handed to Jev:

- The agent gets Pi's built-in `read` / `edit` / `write` / `bash` tools (`createCodingTools` from pi-coding-agent). They accept any path, so the Gate checks the `path` of read / edit / write with `Workspace.resolve`: `..`, `~`, absolute paths outside the root and symlink escapes (including not-yet-existing children) are blocked in code.
- `bash` has no path to check in code; Jev gets one more question, `outsideWorkspace`, for shell commands.
- Unknown tools are blocked.
- The Gate state Jev receives contains redacted, truncated args plus facts about each target (exists, kind, created this run), never file contents.
- The Verifier gets the evidence as clearly marked untrusted data.
- Tools run sequentially (`toolExecution: "sequential"`) so a human approval prompt can't race with other calls.

## decisions.jsonl

The harness appends one line per stage decision:

```json
{"stage":"gate","verdict":"allow","reason":"riskiest=destructive; human approved","subject":"edit {\"path\":\"src/server.ts\",…}","signals":{"destructive":0.72,"irreversible":0.31,"outsideWorkspace":0},"latencyMs":412,"jevModel":"jev-1.13.0","runId":"02-cross-file-bug-…","at":"…"}
```

Strings are redacted before they are written (e-mails, `sk-`/`ghp_` keys, Bearer tokens, `key=value` credentials) and truncated. This lets you replay the signals against new thresholds without calling Jev again.

## Layout

```
src/policies.ts          pure decideRoute / decideGate / decideVerify + FAILURE_POLICY
src/stages/              router.ts, gate.ts (beforeToolCall), verifier.ts: build Jev questions, apply policies
src/harness.ts           runHarness: route → Pi Agent → verify → retry (ModelRuntime, createCodingTools, serializeConversation from pi-coding-agent)
src/workspace.ts         the path boundary the Gate enforces for Pi's tools
src/jev/                 TypeSafe SDK client (proxy, timeout) with answer validation
src/decision-log.ts      redaction + jsonl log
cases/                   the 6 scenarios and the runner
fixtures/workspace/      the toy repo the agent works on
test/                    node:test suite for the policies
```

## Review of the Notion article

The design holds up: Jev only produces calibrated numbers, code owns every action, and failures have an explicit policy. Building it surfaced these points, which the implementation addresses:

1. **Endpoint and version.** The article calls OpenRouter `/api/alpha/decisions` with `typesafe/jev-1.13`, while `apps/jev-examples` uses the TypeSafe SDK (`/v1/systemone`, `jev-1.13.0`). Pick one and pin an exact version, because every threshold is calibrated against it.
2. **Client snippet.** The `Authorization` line came back masked (`******`) through the Notion API, which turned out to be the API redacting it rather than a broken page. The rewritten article uses the SDK, so there is no hand-built header left to copy wrong.
3. **Timeout.** A 2 s timeout combined with SDK retries is either too tight or silently 3× longer. The Gate is on the hot path of every write, so set one explicit budget (here 8 s, 1 retry).
4. **`outsideWorkspace` belongs in code.** The article's §8 itself says hard boundaries are code, yet the Gate example asks Jev for it. Here it's computed by `Workspace.resolve` for file tools and short-circuits before any Jev call; only `bash`, where code can't tell, asks Jev.
5. **Read-only tools** don't need a Gate question; skipping them saves latency and cost deterministically.
6. **`terminate: true` on block** ends the whole run. Returning a block reason that says "don't retry, tell the user" lets the agent recover and explain.
7. **Score scale.** The rubric is described as levels 1..3, but the SDK returns an expected value over 0-based indexes. `quality >= 1.5` and `escalateAtComplexity` only make sense once the scale is stated (0..2 here).
8. **`fallbackTier`** in the Router example is `fast`, which contradicts the failure matrix (`powerful`).
9. **`grounded` is asked but unused** in the Verifier policy. Here it gates acceptance (≥ 0.6) and produces its own feedback line.
10. **The Verifier and Gate see untrusted text.** Evidence and tool args should be marked as data, truncated and **redacted before being sent to Jev**, not only before logging.
11. **Retries** should carry concrete feedback and stay on the same model and agent, which keeps the prompt cache, instead of just "try again".
12. **Parallel tool execution** (Pi's default) conflicts with human approval. Use sequential execution when the Gate can ask.
13. **Approval timeouts** should default to deny, and so should a missing TTY.
14. **Malformed Jev answers** are only mentioned in the tests section. They should be part of the failure policy itself.
15. **Cost and latency figures** are time-sensitive. Date them, or point to `decisions.jsonl`, which records real latencies.
