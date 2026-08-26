import 'dotenv/config';
import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';


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


const { session } = await createAgentSession({
    modelRuntime,
    model,
});

session.subscribe((evt) => {
    if (evt.type !== 'message_update') {
        return;
    }

    if (evt.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(evt.assistantMessageEvent.delta);
    }
});

session.subscribe((evt) => {
    switch (evt.type) {
        case 'agent_start':
        case 'agent_end':
        case 'turn_start':
        case 'turn_end':
        case 'tool_execution_start':
        case 'tool_execution_end':
            process.stdout.write(`\n[${evt.type}] ${JSON.stringify(evt)}\n`);
            break;
    }
})


await session.prompt('please list files in the current directory.')
process.stdout.write('\n');