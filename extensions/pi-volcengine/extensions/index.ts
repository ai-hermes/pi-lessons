import { createProvider } from '@earendil-works/pi-ai';
import type {
    Model, ProviderAuthInteraction, ApiKeyCredential,
    AuthContext, AuthResult, RefreshModelsContext, ProviderStreams, Api
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PROVIDER_ID, PROVIDER_NAME, BASE_URL } from './consts';
import { endpointToModel, fetchVolcengineModels } from './utils';
import { VolcengineEndpointModel } from './type';
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { ARKClient } from '@volcengine/ark';

import './env';



async function login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
    const apiKey = await interaction.prompt({
        type: 'secret',
        message: 'Enter your Volcengine Ark API Key:',
        placeholder: 'Volcengine Ark API Key',
    });
    const accessKeyId = await interaction.prompt({
        type: 'secret',
        message: 'Enter your Volcengine Ark Access Key ID:',
        placeholder: 'Volcengine Ark Access Key ID',
    });
    const secretAccessKey = await interaction.prompt({
        type: 'secret',
        message: 'Enter your Volcengine Ark Secret Access Key:',
        placeholder: 'Volcengine Ark Secret Access Key',
    })
    return {
        type: 'api_key',
        key: apiKey,
        env: {
            VOLCENGINE_ACCESS_KEY_ID: accessKeyId,
            VOLCENGINE_SECRET_ACCESS_KEY: secretAccessKey,
        }
    }
}

async function resolve(input: {
    ctx: AuthContext;
    credential?: ApiKeyCredential;
    signal: AbortSignal;
}): Promise<AuthResult | undefined> {
    const { ctx, credential } = input;
    const key = credential?.key || (await ctx.env("VOLCENGINE_API_KEY"));
    const accessKeyId = credential?.env?.VOLCENGINE_ACCESS_KEY_ID || (await ctx.env("VOLCENGINE_ACCESS_KEY_ID"));
    const secretAccessKey = credential?.env?.VOLCENGINE_SECRET_ACCESS_KEY || (await ctx.env("VOLCENGINE_SECRET_ACCESS_KEY"));
    if (!key || !accessKeyId || !secretAccessKey) {
        return undefined;
    }
    return {
        auth: {
            apiKey: credential?.key || (await ctx.env('VOLCENGINE_API_KEY')),
        },
        env: {
            ...(accessKeyId ? { VOLCENGINE_ACCESS_KEY_ID: accessKeyId } : {}),
            ...(secretAccessKey ? { VOLCENGINE_SECRET_ACCESS_KEY: secretAccessKey } : {})
        },
        source: credential ? 'Stored Volcengine Credentials' : 'Volcengine Environment Variables',
    }
}

async function fetchModels(context: RefreshModelsContext): Promise<Model<'openai-completions'>[]> {
    if (!context.allowNetwork) return [];

    const credential = context.credential?.type === "api_key"
        ? context.credential as ApiKeyCredential
        : undefined;
    const accessKeyId = credential?.env?.VOLCENGINE_ACCESS_KEY_ID;
    const secretAccessKey = credential?.env?.VOLCENGINE_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
        throw new Error("Volcengine credentials are not available. Please login or set the environment variables first.");
    }


    const arkClient = new ARKClient({
        accessKeyId,
        secretAccessKey
    });

    const volcengineModels = await fetchVolcengineModels(arkClient);
    const models = volcengineModels.map(item => endpointToModel(item)).filter(Boolean) as any;
    return models
}


export function endpointIdFromModel<TApi extends Api>(model: Model<TApi>): string {
    const endpointId = (model as unknown as VolcengineEndpointModel).endpointId;
    return typeof endpointId === "string" && endpointId.startsWith("ep-")
        ? endpointId
        : model.id;
}

export function withEndpointModelIds(upstream: ProviderStreams): ProviderStreams {
    return {
        stream(model, context, options) {
            return upstream.stream(
                { ...model, id: endpointIdFromModel(model) },
                context,
                options,
            );
        },
        streamSimple(model, context, options) {
            return upstream.streamSimple(
                { ...model, id: endpointIdFromModel(model) },
                context,
                options,
            );
        },
    };
}

function createVolcengineProvider() {
    const provider = createProvider<"openai-completions">({
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        baseUrl: BASE_URL,
        auth: {
            apiKey: {
                name: "Volcengine Ark API Key + AK/SK",
                login,
                resolve,
            }
        },
        models: [] as Model<"openai-completions">[],
        fetchModels,
        api: withEndpointModelIds(openAICompletionsApi()),
    })
    return provider;
}

export default (pi: ExtensionAPI) => {
    pi.registerProvider(createVolcengineProvider());
}