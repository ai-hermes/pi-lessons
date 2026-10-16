# jev-examples

Example cases for [Jev](https://docs.typesafe.ai/api) (TypeSafe System One): hand the "judgment calls" to Jev, get structured answers with probabilities via Choice / Score / Noul questions, and let code handle everything else. The cases come from [Notion · Jev](https://app.notion.com/p/dingwenjiang/Jev-3e325bd1f17780088ef7ee5d8f482a3a).

```bash
pnpm install
cp apps/jev-examples/.env.example apps/jev-examples/.env   # fill in TYPESAFE_API_KEY
pnpm --filter jev-examples run 01   # 01 ~ 06, or all
pnpm --filter jev-examples typecheck
```

## Configuration

Each script automatically loads `apps/jev-examples/.env` on startup (existing environment variables take precedence) and calls `POST /v1/systemone` through the official [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk) (`TypeSafeClient`, up to 3 retries with backoff on 408 / 429 / 5xx). If `TYPESAFE_API_KEY` is not set, the script exits with an error.

Optional variables: `TYPESAFE_BASE_URL`, `TYPESAFE_LOG_LEVEL`, `JEV_TIMEOUT_MS` (default 30000). The API is region-restricted: if it returns 451, set `HTTPS_PROXY` (or `HTTP_PROXY`) and requests will go through that proxy (passed to the SDK via its `fetch` option, using undici's `EnvHttpProxyAgent`). `.env` is git-ignored; never commit your key.

## Cases

| Case | File | Question types | Highlights |
| --- | --- | --- | --- |
| 1 | `01-ticket-routing.ts` | Choice + Noul + Score | Ticket routing: hard rules first, confidence thresholds, refund tagging, SLA; shadow mode only suggests |
| 2 | `02-tool-model-routing.ts` | Choice | Tool / model routing: code filters available options, mandatory fallback option, position-bias check, arguments generated and validated by code |
| 3 | `03-writing-check.ts` | Noul + Choice + Score | Writing QA: strip quotes / code blocks, code rules first, audience-aware tone judgment |
| 4 | `04-rag-filter.ts` | Noul (batched) | RAG candidate filtering: BM25 + vector RRF retrieval, dedupe to latest version, per-candidate relevance questions referencing candidates by ID, citation check |
| 5 | `05-coding-proposal-review.ts` | Noul | Coding agent proposal review: schema / path / diff validation, pinned model version, decision table and audit record |
| 6 | `06-browser-action.ts` | Choice (multi-turn) | Browser action selection: numbered visible elements, dynamic action set, page-version recheck before execution, stuck detection; a low-probability DONE becomes WAIT, and a DONE rejected by code verification is fed back to the next round |

`shared/jev.ts` is a thin wrapper around the SDK: question types and the `choice` / `score` / `noul` builders come straight from `@typesafe-ai/sdk`, so answer types are inferred from the questions (e.g. `choice` is typed as the option keys). On top of that it adds latency timing, maps SDK errors to `JevUnavailableError`, and runtime-validates answers (options must be within `criteria`, probabilities must sum to ≈1, scores in range) — the SDK does not check these.

All `state` keys, question IDs, option keys and instructions are in English (e.g. `task`, `evidence`, `addresses_task`, `needs_clarification`, `permit`), and the code branches directly on these keys. When you change question wording, bump the question set version as well (see `QUESTION_SET_VERSION` in case 5).

## Safety boundaries

Jev's output is **decision evidence, not authorization**. Every case follows these rules:

- Hard rules, permissions, arguments and final execution are decided by code;
- Low confidence, missing answers or Jev being unavailable degrade gracefully (human review / suggestion only / fallback option) instead of surfacing errors to the user;
- "Instructions" embedded in untrusted inputs such as page content or documents are never executed (see the cookie-banner injection in case 6).

## References

- [Notion · Jev cases](https://app.notion.com/p/dingwenjiang/Jev-3e325bd1f17780088ef7ee5d8f482a3a)
- [TypeSafe API docs](https://docs.typesafe.ai/api)
