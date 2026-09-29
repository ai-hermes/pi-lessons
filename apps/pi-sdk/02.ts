import 'dotenv/config';
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';

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
    const candidates = modelRuntime
        .getModels('deepseek')
        .map((item) => item.id)
        .join(', ');
    throw new Error(`DeepSeek model not found: deepseek/${modelId}. Available: ${candidates}`);
}

const { session } = await createAgentSession({
    model,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
});

session.subscribe((evt) => {
    if (evt.type === 'message_update' && evt.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(evt.assistantMessageEvent.delta);
    }
})

await session.prompt('how many files are there in this project(exclude node_modules)?')