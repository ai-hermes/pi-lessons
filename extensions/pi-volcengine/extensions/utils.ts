import type { Model } from '@earendil-works/pi-ai';
import { ARKClient, ListEndpointsCommand } from '@volcengine/ark';
import {
    VolcengineEndpointModel,
    ListEndpointsItem,
    InnerDescribeModelEndpointsCommand, InnerDescribeModelEndpointsItem,
} from './type'
import { BASE_URL, ZERO_COST, PAGE_SIZE } from "./consts";
import { MODEL_DATA, type ModelData } from './model-data';

export async function fetchVolcengineModels(arkClient: ARKClient): Promise<ListEndpointsItem[]> {
    const buildInEndpoints: ListEndpointsItem[] = [];
    let fetchedCount = 0;
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
        const command = new InnerDescribeModelEndpointsCommand({
            PageSize: PAGE_SIZE,
            PageNumber: pageNumber,
        });
        const response = await arkClient.send(command);
        const items = response.Result?.Items ?? [];
        fetchedCount += items.length;
        buildInEndpoints.push(...items);

        if (fetchedCount >= (response.Result?.TotalCount ?? 0) || items.length === 0) break;
    }


    fetchedCount = 0;
    const customEndpoints: InnerDescribeModelEndpointsItem[] = [];
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
        const command = new ListEndpointsCommand({
            PageSize: PAGE_SIZE,
            PageNumber: pageNumber,
        });
        const response = await arkClient.send(command);
        const items = response.Result?.Items ?? [];
        fetchedCount += items.length;
        console.log(`Fetched ${items.length} endpoints on page ${pageNumber}, total fetched: ${fetchedCount}`);
        customEndpoints.push(...items);

        if (fetchedCount >= (response.Result?.TotalCount ?? 0) || items.length === 0) break;
    }
    return [...buildInEndpoints, ...customEndpoints]
}

/** Fallback heuristic flags for models not yet in MODEL_DATA. */
function heuristicVision(modelName: string): boolean {
    return /(vision|vl|doubao-seed|kimi-k2\.6|multimodal)/.test(modelName);
}

function heuristicReasoning(modelName: string): boolean {
    return /(deepseek|reason|thinking|r1|glm-5|kimi)/.test(modelName);
}

export function endpointToModel(
    endpoint: ListEndpointsItem,
): VolcengineEndpointModel | undefined {
    if (endpoint.Status !== 'Running' || !endpoint.Id || !endpoint.Name) return undefined;

    const endpointId = endpoint.Id ?? '';
    const reference = endpoint.ModelReference;
    const foundation = reference?.FoundationModel;
    const modelVersion = foundation?.ModelVersion;
    const modelName = foundation?.Name ?? '';
    const id = `${modelName}${modelVersion ? `(${modelVersion})` : ''}`;

    // Look up offline-prepared data (pricing, context window, capabilities).
    // Falls back to heuristic defaults for models not yet in MODEL_DATA.
    const data: ModelData | undefined = MODEL_DATA[id];
    const reasoning = data?.reasoning ?? heuristicReasoning(modelName);
    const vision = data?.vision ?? heuristicVision(modelName);

    return {
        id,
        name: modelName,
        api: "openai-completions",
        provider: "volcengine",
        baseUrl: BASE_URL,
        reasoning,
        input: vision ? ["text", "image"] : ["text"],
        cost: data
            ? { ...data.cost, ...(data.cost.tiers ? { tiers: data.cost.tiers.map(t => ({ ...t })) } : {}) }
            : { ...ZERO_COST },
        contextWindow: data?.contextWindow ?? 128_000,
        maxTokens: data?.maxTokens ?? 16_384,
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: reasoning,
            ...(reasoning ? { thinkingFormat: "deepseek" as const } : {}),
        },
        endpointId,
    };
}
