/** The LLM behind the Pi agent: any OpenAI-compatible endpoint, DeepSeek by default. */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
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
	if (!apiKey) throw new Error("LLM_API_KEY (or DEEPSEEK_API_KEY) is not set; see .env.example.");
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
