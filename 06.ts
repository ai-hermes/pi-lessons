import 'dotenv/config';
import { createAgentSession, ModelRuntime, DefaultResourceLoader, getAgentDir, Skill, createSyntheticSourceInfo } from '@earendil-works/pi-coding-agent';
import path from 'node:path';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY environment variable is not set');
}

const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

const modelRuntime = await ModelRuntime.create();
modelRuntime.registerProvider('deepseek', {
    baseUrl: 'https://api.deepseek.com',
    apiKey,
})

const model = modelRuntime.getModel('deepseek', modelName);
if (!model) {
    throw new Error(`Model ${modelName} not found`);
}

const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: (current) => {
        return 'Your a copilot that help people handle daily work.'
    },
    appendSystemPromptOverride: (current) => {
        return [
            ...current,
            'Alaways answer in Chinese.',
        ]
    }
});
await loader.reload();


const { session } = await createAgentSession({
    modelRuntime,
    model,
    resourceLoader: loader,
});

session.subscribe((evt) => {
    if (evt.type !== 'message_update') {
        return;
    }

    if (evt.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(evt.assistantMessageEvent.delta);
    }
});

await session.prompt(`who are you?`);
process.stdout.write('\n');
