/**
 * LLM backends for the Pi agent: an OpenAI-compatible endpoint for real runs, and Pi's faux provider for
 * offline runs / tests (scripted assistant messages, no network).
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFauxCore, type FauxResponseStep, type Model } from "@earendil-works/pi-ai";
import { streamSimple as openAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { env } from "./env.ts";
import type { Tier } from "./policies.ts";

export interface LlmBackend {
	label: string;
	streamFn: StreamFn;
	getApiKey: (provider: string) => string | undefined;
	models: Record<Tier, Model<any>>;
}

function openAICompatibleModel(id: string, baseUrl: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "harness-llm",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

export function createOnlineLlm(): LlmBackend {
	const apiKey = env("LLM_API_KEY") ?? env("DEEPSEEK_API_KEY");
	if (!apiKey) throw new Error("LLM_API_KEY (or DEEPSEEK_API_KEY) is not set; see .env.example or use --offline.");
	const baseUrl = env("LLM_BASE_URL") ?? "https://api.deepseek.com";
	const models = {
		fast: openAICompatibleModel(env("LLM_FAST_MODEL") ?? "deepseek-v4-flash", baseUrl),
		powerful: openAICompatibleModel(env("LLM_POWERFUL_MODEL") ?? "deepseek-v4-pro", baseUrl),
	};
	return {
		label: `${baseUrl} (fast=${models.fast.id}, powerful=${models.powerful.id})`,
		streamFn: openAICompletionsStream as StreamFn,
		getApiKey: () => apiKey,
		models,
	};
}

/** Scripted LLM: each agent turn consumes the next step. */
export function createOfflineLlm(steps: FauxResponseStep[]): LlmBackend {
	const core = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-fast" }, { id: "faux-powerful" }],
		tokensPerSecond: 0,
	});
	core.setResponses(steps);
	return {
		label: "offline (Pi faux provider)",
		streamFn: core.streamSimple as StreamFn,
		getApiKey: () => "offline",
		models: { fast: core.getModel("faux-fast")!, powerful: core.getModel("faux-powerful")! },
	};
}
