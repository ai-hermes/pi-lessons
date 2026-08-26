# Volcengine Ark extension for pi

A pi extension that registers a Volcengine Ark provider with dynamic endpoint
refresh. Model pricing / context-window / capability data is baked into the
extension at build time via an offline-prepared lookup table.

## How it works

```
                    OFFLINE (build time)                      RUNTIME
                    ──────────────────                         ────────
  LiteLLM pricing ─┐
                   ├─→ gen-manifest.ts ──→ volcengine.models.json
  Ark endpoints ───┘                     └─→ extensions/model-data.ts ──→ endpointToModel()
                                          (baked-in lookup table)         (uses MODEL_DATA + live endpointId)
```

1. **Offline**: `bun run gen` fetches LiteLLM pricing data + your Ark endpoints,
   produces `volcengine.models.json` (manifest) and `extensions/model-data.ts`
   (typed lookup table baked into the extension).

2. **Runtime**: `endpointToModel()` looks up each live Ark endpoint's model
   name in the baked-in `MODEL_DATA` table. Known models get accurate pricing /
   context-window / capabilities; unknown models fall back to regex heuristics.
   The **live `endpointId` always wins** over any baked-in value.

No JSON files are loaded at runtime — `model-data.ts` is compiled TypeScript.

## Files

| File | Role | Shipped? |
|---|---|---|
| `extensions/model-data.ts` | Auto-generated lookup table (pricing/context/capability per model) | ✅ committed |
| `extensions/utils.ts` | `endpointToModel` uses `MODEL_DATA` + fallback heuristics | ✅ |
| `extensions/index.ts` | Provider registration | ✅ |
| `litellm-models.json` | Build input — LiteLLM pricing/context data | ❌ gitignored |
| `volcengine.endpoints.json` | Build input — your account's running Ark endpoints | ❌ gitignored |
| `volcengine.models.json` | Build intermediate — full manifest (source for `model-data.ts`) | ❌ gitignored |
| `gen-manifest.ts` | Combines build inputs → `model-data.ts` + manifest | ✅ |

## Regenerating the lookup table

```sh
bun run gen        # fetch-litellm + fetch-endpoints + gen-manifest
```

Or step by step:

```sh
bun run fetch     # download litellm-models.json + volcengine.endpoints.json
bun run manifest  # combine → volcengine.models.json + extensions/model-data.ts
```

### Prerequisites

`scripts/fetch-endpoints.ts` reads Volcengine credentials from `.env`:

```dotenv
VOLCENGINE_ACCESS_KEY_ID=...
VOLCENGINE_SECRET_ACCESS_KEY=...
VOLCENGINE_API_KEY=...
```

`scripts/fetch-litellm.ts` downloads from GitHub raw with mirror fallback
(`ghfast.top` / `ghproxy.com`) for flaky networks. Override mirrors:
```sh
LITELLM_MIRRORS="https://ghfast.top/" bun run fetch
```

## Pricing methodology (chat models)

- Prefer a `volcengine/…` LiteLLM entry (most authoritative, incl. tiered pricing)
- Else the model's native-provider LiteLLM entry as an *estimate*
- Else `0` (unknown). Units: USD per 1M tokens.

The `ENRICH` table in `gen-manifest.ts` selects which LiteLLM key supplies
pricing vs. context-window for each model family — edit it when new models
appear in your account.
