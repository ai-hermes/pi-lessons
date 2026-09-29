import 'dotenv/config';
import { createAgentSession, ModelRuntime, DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from "typebox";
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
    throw new Error(
        'Missing API key. Set DEEPSEEK_API_KEY in .env/environment.',
    );
}

const modelId = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';

const modelRuntime = await ModelRuntime.create();
modelRuntime.registerProvider('deepseek', { baseUrl });
await modelRuntime.setRuntimeApiKey('deepseek', apiKey);

const model = modelRuntime.getModel('deepseek', modelId);
if (!model) {
    throw new Error(`${modelId} not exist under the provider deepseek`)
}

const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: (base) => {
        return `${base}\n\nAlways answer in Chinese`
    },
})
await loader.reload();

const { session } = await createAgentSession({
    model,
    modelRuntime,
    resourceLoader: loader,
});

session.subscribe((evt) => {
    if (evt.type === 'message_update' && evt.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(evt.assistantMessageEvent.delta);
    }
})

await session.prompt('Please introducte yourself.');
// await session.prompt('What tools do you have?')
