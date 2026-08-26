// Generates a Volcengine model manifest (pi-ai multi-api catalog) by combining
// the Running endpoints in your Volcengine Ark account with pricing /
// context-window data from LiteLLM's model_prices_and_context_window.json
// (https://github.com/BerriAI/litellm/blob/litellm_internal_staging/model_prices_and_context_window.json).
//
// Inputs (regenerate with the scripts/ helpers before running this):
//   litellm-models.json        — `bun run scripts/fetch-litellm.ts`
//   volcengine.endpoints.json  — `bun run scripts/fetch-endpoints.ts`
//
// The manifest is keyed by API type (pi-ai `ModelGroups` shape), because pi-ai
// dispatches requests by `model.api`. Volcengine Ark exposes several distinct
// HTTP APIs, so models are categorized by modality:
//
//   "openai-completions"  — streaming chat (doubao-seed, deepseek, glm, kimi …)
//   "volcengine-images"   — image generation (doubao-seedream), Ark /images/generations
//   "volcengine-video"    — video generation (doubao-seedance), Ark async task API
//
// `volcengine-images` / `volcengine-video` are forward-looking custom API keys:
// the catalog is complete now, but the extension must register corresponding
// `ProviderStreams` / image adapters for these APIs before they can be invoked.
//
// Methodology per chat model:
//  * contextWindow / maxTokens: prefer a `volcengine` litellm entry, else the
//    model's native-provider litellm entry, else a conservative default.
//  * cost (USD per 1M tokens): prefer a `volcengine` litellm entry (incl. tiered
//    pricing), else the native-provider litellm entry as an *estimate*, else 0.
//  * reasoning / vision: LiteLLM `supports_reasoning`/`supports_vision` when
//    available, else the regex heuristics used by extensions/utils.ts.
// Image/video models are priced per Ark docs when known, else 0 (unknown).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    Model, ModelCost, ModelCostTier, OpenAICompletionsCompat,
    ImagesModel, ImagesApi,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of LiteLLM's model_prices_and_context_window.json entry that we use. */
interface LiteLLMEntry {
    litellm_provider?: string;
    mode?: string;
    input_cost_per_token?: number;
    output_cost_per_token?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
    max_tokens?: number;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    supports_function_calling?: boolean;
    supports_tool_choice?: boolean;
    supports_prompt_caching?: boolean;
    tiered_pricing?: LiteLLMTier[];
}

interface LiteLLMTier {
    input_cost_per_token: number;
    output_cost_per_token: number;
    range: [number, number];
}

type LiteLLMDatabase = Record<string, LiteLLMEntry>;

/** Output of dump-running.ts — a Running Ark builtin endpoint. */
interface RunningEndpoint {
    endpointId: string;
    name: string;
    modelName: string;
    modelVersion?: string;
    endpointModelType: string;
}

/** Manual enrichment mapping for each chat model family in the account. */
interface EnrichSpec {
    /** LiteLLM key used for pricing (preferring volcengine). null = unknown. */
    price: string | null;
    /** LiteLLM key used for context window / max tokens. null = use defaults. */
    ctx: string | null;
    note?: string;
}

/** Ark modality inferred from the foundation model name. */
type Modality = "chat" | "image" | "video" | "embedding";

/** A chat model entry = pi-ai Model + Ark endpoint id + optional note. */
type VolcengineChatModel = Model<"openai-completions"> & {
    endpointId: string;
    note?: string;
};

/** An image model entry = pi-ai ImagesModel + Ark endpoint id. */
type VolcengineImageModel = ImagesModel<ImagesApi> & {
    endpointId: string;
    note?: string;
};

/**
 * A video model entry. pi-ai has no native video API type, so this is a
 * catalog-only shape mirroring ImagesModel; the extension must implement a
 * `"volcengine-video"` adapter to invoke it.
 */
interface VolcengineVideoModel {
    id: string;
    name: string;
    api: "volcengine-video";
    provider: "volcengine";
    baseUrl: string;
    input: ("text" | "image")[];
    output: ("video")[];
    cost: ModelCost;
    endpointId: string;
    note?: string;
}

interface Manifest {
    "openai-completions": Record<string, VolcengineChatModel>;
    "volcengine-images": Record<string, VolcengineImageModel>;
    "volcengine-video": Record<string, VolcengineVideoModel>;
}

interface PricingSource {
    id: string;
    api: string;
    pricingSource: string;
    ctxSource: string;
    contextWindow?: number;
    maxTokens?: number;
    input: number;
    output: number;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const litellm: LiteLLMDatabase = JSON.parse(readFileSync(join(here, "litellm-models.json"), "utf8"));
const endpoints: RunningEndpoint[] = JSON.parse(readFileSync(join(here, "volcengine.endpoints.json"), "utf8"));

const BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const PROVIDER = "volcengine";

/** Classify an Ark foundation model name into its modality. */
function modalityOf(modelName: string): Modality {
    if (/embedding/i.test(modelName)) return "embedding";
    if (/seedream|seed-edit|seed-restore/i.test(modelName)) return "image";
    if (/seedance|seedance/i.test(modelName)) return "video";
    return "chat";
}

// Per-model enrichment for chat models: which litellm key supplies pricing
// (preferring volcengine), and which supplies context window.
const ENRICH: Record<string, EnrichSpec> = {
    "deepseek-v4-pro-ga":     { price: "deepseek/deepseek-v4-pro",   ctx: "deepseek/deepseek-v4-pro" },
    "deepseek-v4-flash-ga":   { price: "deepseek/deepseek-v4-flash", ctx: "deepseek/deepseek-v4-flash" },
    "deepseek-v4-pro":        { price: "deepseek/deepseek-v4-pro",   ctx: "deepseek/deepseek-v4-pro" },
    "deepseek-v4-flash":      { price: "deepseek/deepseek-v4-flash", ctx: "deepseek/deepseek-v4-flash" },
    "deepseek-v3":            { price: "deepseek/deepseek-v3",       ctx: "deepseek/deepseek-v3" },
    "glm-5-2":                { price: "dashscope/glm-5.2",          ctx: "dashscope/glm-5.2" },
    "glm-4-7":                { price: "glm-4-7-251222",            ctx: "glm-4-7-251222" },
    "doubao-seed-2-0-pro":    { price: "volcengine/doubao-seed-2-0-pro-260215",  ctx: "volcengine/doubao-seed-2-0-pro-260215" },
    "doubao-seed-2-1-turbo":  { price: "volcengine/doubao-seed-2-0-lite-260215", ctx: "volcengine/doubao-seed-2-0-pro-260215", note: "pricing estimated from doubao-seed-2-0-lite (2-1-turbo not in litellm)" },
    "doubao-seed-1-8":        { price: null, ctx: "volcengine/doubao-seed-2-0-pro-260215", note: "pricing unknown (not in litellm); context estimated from seed-2-0 family" },
    "doubao-seed-1-6":        { price: null, ctx: "volcengine/doubao-seed-2-0-pro-260215", note: "pricing unknown (not in litellm); context estimated from seed-2-0 family" },
    "doubao-1-5-pro-32k":     { price: null, ctx: null, note: "not in litellm; 32k context per model name" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroCost(): ModelCost {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Convert LiteLLM tiered_pricing (ascending by range start) into pi-ai ModelCost tiers. */
function tieredToCost(tiers: LiteLLMTier[]): ModelCost {
    const [base, ...rest] = tiers;
    const toTier = (t: LiteLLMTier): ModelCostTier => ({
        inputTokensAbove: t.range[0],
        input: t.input_cost_per_token * 1e6,
        output: t.output_cost_per_token * 1e6,
        cacheRead: 0,
        cacheWrite: 0,
    });
    return {
        input: base.input_cost_per_token * 1e6,
        output: base.output_cost_per_token * 1e6,
        cacheRead: 0,
        cacheWrite: 0,
        tiers: rest.map(toTier),
    };
}

function regexVision(name: string): boolean {
    return /(vision|vl|doubao-seed|multimodal)/.test(name);
}

function regexReasoning(name: string): boolean {
    return /(deepseek|reason|thinking|r1|glm-5|kimi)/.test(name);
}

const PRETTY_NAMES: Record<string, string> = {
    "deepseek-v4-pro-ga": "DeepSeek V4 Pro (GA)",
    "deepseek-v4-flash-ga": "DeepSeek V4 Flash (GA)",
    "deepseek-v4-pro": "DeepSeek V4 Pro",
    "deepseek-v4-flash": "DeepSeek V4 Flash",
    "deepseek-v3": "DeepSeek V3",
    "glm-5-2": "GLM-5.2",
    "glm-4-7": "GLM-4.7",
    "doubao-seed-2-0-pro": "Doubao Seed 2.0 Pro",
    "doubao-seed-2-1-turbo": "Doubao Seed 2.1 Turbo",
    "doubao-seed-1-8": "Doubao Seed 1.8",
    "doubao-seed-1-6": "Doubao Seed 1.6",
    "doubao-1-5-pro-32k": "Doubao 1.5 Pro 32K",
    "doubao-seedream-5-0-pro": "Doubao Seedream 5.0 Pro",
    "doubao-seedream-5-0": "Doubao Seedream 5.0",
    "doubao-seedream-4-5": "Doubao Seedream 4.5",
    "doubao-seedream-4-0": "Doubao Seedream 4.0",
    "doubao-seedance-2-0": "Doubao Seedance 2.0",
    "doubao-seedance-1-5-pro": "Doubao Seedance 1.5 Pro",
};

function prettyName(modelName: string): string {
    return PRETTY_NAMES[modelName] ?? modelName;
}

// ---------------------------------------------------------------------------
// Chat model generation
// ---------------------------------------------------------------------------

function buildChatModel(ep: RunningEndpoint): { model: VolcengineChatModel; src: PricingSource } | null {
    const name = ep.modelName;
    const e: EnrichSpec = ENRICH[name] ?? { price: null, ctx: null };

    // cost
    let cost = zeroCost();
    let pricingSource = "none (unknown)";
    const priceEntry = e.price ? litellm[e.price] : undefined;
    if (priceEntry) {
        if (priceEntry.tiered_pricing) {
            cost = tieredToCost(priceEntry.tiered_pricing);
            pricingSource = `${e.price} (tiered)`;
        } else if (priceEntry.input_cost_per_token != null) {
            cost = {
                input: priceEntry.input_cost_per_token * 1e6,
                output: (priceEntry.output_cost_per_token ?? 0) * 1e6,
                cacheRead: 0,
                cacheWrite: 0,
            };
            pricingSource = e.price!;
        }
    }

    // context window / max tokens
    let contextWindow = 128_000;
    let maxTokens = 16_384;
    let ctxSource = "default (128k/16k)";
    const ctxEntry = e.ctx ? litellm[e.ctx] : undefined;
    if (ctxEntry) {
        if (ctxEntry.max_input_tokens) { contextWindow = ctxEntry.max_input_tokens; ctxSource = e.ctx!; }
        if (ctxEntry.max_output_tokens) maxTokens = ctxEntry.max_output_tokens;
    }
    if (name === "doubao-1-5-pro-32k") { contextWindow = 32_768; maxTokens = 8_192; ctxSource = "model name (32k)"; }

    // reasoning / vision: prefer litellm flags, else regex
    const ref: LiteLLMEntry = priceEntry ?? ctxEntry ?? {};
    const reasoning = ref.supports_reasoning != null ? ref.supports_reasoning : regexReasoning(name);
    const vision = ref.supports_vision != null ? ref.supports_vision : regexVision(name);
    const reasoningFinal = name === "deepseek-v3" ? false : reasoning;

    const id = `${name}${ep.modelVersion ? `(${ep.modelVersion})` : ""}`;
    const compat: OpenAICompletionsCompat = {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: reasoningFinal,
        maxTokensField: "max_tokens",
        ...(reasoningFinal
            ? { thinkingFormat: "deepseek" as const, requiresReasoningContentOnAssistantMessages: true }
            : {}),
    };
    const model: VolcengineChatModel = {
        id,
        name: prettyName(name),
        api: "openai-completions",
        provider: PROVIDER,
        baseUrl: BASE_URL,
        reasoning: reasoningFinal,
        input: vision ? ["text", "image"] : ["text"],
        cost,
        contextWindow,
        maxTokens,
        compat,
        endpointId: ep.endpointId,
        ...(e.note ? { note: e.note } : {}),
    };
    return {
        model,
        src: { id, api: "openai-completions", pricingSource, ctxSource, contextWindow, maxTokens, input: cost.input, output: cost.output },
    };
}

// ---------------------------------------------------------------------------
// Image / video model generation
// ---------------------------------------------------------------------------

function buildImageModel(ep: RunningEndpoint): VolcengineImageModel {
    const id = `${ep.modelName}${ep.modelVersion ? `(${ep.modelVersion})` : ""}`;
    return {
        id,
        name: prettyName(ep.modelName),
        api: "volcengine-images",
        provider: PROVIDER,
        baseUrl: BASE_URL,
        input: ["text", "image"],
        output: ["image"],
        cost: zeroCost(),
        endpointId: ep.endpointId,
        note: "pricing unknown (Ark visual generation; not in litellm)",
    };
}

function buildVideoModel(ep: RunningEndpoint): VolcengineVideoModel {
    const id = `${ep.modelName}${ep.modelVersion ? `(${ep.modelVersion})` : ""}`;
    return {
        id,
        name: prettyName(ep.modelName),
        api: "volcengine-video",
        provider: PROVIDER,
        baseUrl: BASE_URL,
        input: ["text", "image"],
        output: ["video"],
        cost: zeroCost(),
        endpointId: ep.endpointId,
        note: "pricing unknown (Ark async video task API; not in litellm)",
    };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const manifest: Manifest = {
    "openai-completions": {},
    "volcengine-images": {},
    "volcengine-video": {},
};
const pricingSources: PricingSource[] = [];
let skippedEmbeddings = 0;

for (const ep of endpoints) {
    const modality = modalityOf(ep.modelName);
    switch (modality) {
        case "chat": {
            const r = buildChatModel(ep);
            if (r) {
                manifest["openai-completions"][r.model.id] = r.model;
                pricingSources.push(r.src);
            }
            break;
        }
        case "image": {
            const m = buildImageModel(ep);
            manifest["volcengine-images"][m.id] = m;
            pricingSources.push({ id: m.id, api: m.api, pricingSource: "none (unknown)", ctxSource: "n/a", input: 0, output: 0 });
            break;
        }
        case "video": {
            const m = buildVideoModel(ep);
            manifest["volcengine-video"][m.id] = m;
            pricingSources.push({ id: m.id, api: m.api, pricingSource: "none (unknown)", ctxSource: "n/a", input: 0, output: 0 });
            break;
        }
        case "embedding": {
            // Embedding models are not part of this chat/image/video manifest.
            skippedEmbeddings++;
            break;
        }
    }
}

const out = join(here, "volcengine.models.json");
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log("wrote", out);

// ---------------------------------------------------------------------------
// Generate extensions/model-data.ts — a typed lookup table baked into the
// extension at build time. endpointToModel() uses this instead of loading the
// JSON manifest at runtime (no JSON import, no runtime file dependency).
// ---------------------------------------------------------------------------

const chatModels = manifest["openai-completions"];
const entries = Object.values(chatModels).map((m) => {
    const c = m.cost;
    const tiers = c.tiers ?? [];
    return [
        `    ${JSON.stringify(m.id)}: {`,
        `        contextWindow: ${m.contextWindow},`,
        `        maxTokens: ${m.maxTokens},`,
        `        reasoning: ${m.reasoning},`,
        `        vision: ${m.input.includes("image")},`,
        `        cost: { input: ${c.input}, output: ${c.output}, cacheRead: ${c.cacheRead}, cacheWrite: ${c.cacheWrite}${tiers.length > 0 ? `, tiers: [${tiers.map((t) => `{ inputTokensAbove: ${t.inputTokensAbove}, input: ${t.input}, output: ${t.output}, cacheRead: ${t.cacheRead}, cacheWrite: ${t.cacheWrite} }`).join(", ")}]` : ""} },`,
        `    },`,
    ].join("\n");
}).join("\n");

const ts = `// AUTO-GENERATED by gen-manifest.ts — do not edit manually.
// Source: volcengine.models.json (offline-prepared from LiteLLM + Ark endpoints)
// Used by endpointToModel() to enrich live Ark endpoints with pricing / context
// / capability data without loading any JSON at runtime.

export interface ModelData {
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    vision: boolean;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
    };
}

export const MODEL_DATA: Record<string, ModelData> = {
${entries}
};
`;

const tsOut = join(here, "extensions", "model-data.ts");
writeFileSync(tsOut, ts);
console.log("wrote", tsOut);

console.log("  openai-completions:", Object.keys(manifest["openai-completions"]).length);
console.log("  volcengine-images: ", Object.keys(manifest["volcengine-images"]).length);
console.log("  volcengine-video:  ", Object.keys(manifest["volcengine-video"]).length);
console.log("  embeddings skipped:", skippedEmbeddings);
console.log("\n" + JSON.stringify(pricingSources, null, 2));
