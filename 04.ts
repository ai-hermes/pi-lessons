import 'dotenv/config';
import { createAgentSession, ModelRuntime, defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

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


const customUTCTimeTool = defineTool({
    name: "utc_time",
    label: "🔧 get UTC time",
    description: "Get the current UTC time",
    parameters: Type.Object({}),
    execute: async () => {
        return {
            content: [
                {
                    type: 'text',
                    text: `The current UTC time is: ${new Date().toISOString()}`
                }
            ],
            details: {},
        }
    }
})

const { session } = await createAgentSession({
    modelRuntime,
    model,
    // noTools: 'builtin',
    // excludeTools: ['edit', 'write'],
    customTools: [customUTCTimeTool],
});

session.subscribe((evt) => {
    switch (evt.type) {
        case 'tool_execution_start':
            process.stdout.write(`\n[Tool execution started: ${evt.toolName}]\n`);
            break;
        case 'tool_execution_end':
            process.stdout.write(`\n[Tool execution ended: ${evt.toolName}], result is ${JSON.stringify(evt.result)}\n`);
            break;
    }

    if (evt.type !== 'message_update') {
        return;
    }

    if (evt.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(evt.assistantMessageEvent.delta);
    }
});



await session.prompt('What is the current UTC time, and explain the timezone');
process.stdout.write('\n');
