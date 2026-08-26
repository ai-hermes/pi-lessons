import 'dotenv/config';
import { createAgentSession, ModelRuntime, DefaultResourceLoader, getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent';
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
});
await loader.reload();


const sessionManager = SessionManager.continueRecent(
    process.cwd(),
    path.join(process.cwd(), 'sessions'),
);

const { session } = await createAgentSession({
    modelRuntime,
    model,
    resourceLoader: loader,
    sessionManager,
});

session.subscribe((evt) => {
    if (evt.type !== 'message_update') {
        return;
    }

    if (evt.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(evt.assistantMessageEvent.delta);
    }
});

// await session.prompt(`hi, myfavourite color is blue.`);
// await session.prompt(`What's my favourite color?`);
await session.prompt(`Write a poem according my favourite  color`);
process.stdout.write('\n');
