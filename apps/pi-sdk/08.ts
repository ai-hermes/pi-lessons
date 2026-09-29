import 'dotenv/config';
import { createAgentSession, ModelRuntime, DefaultResourceLoader, getAgentDir, createEventBus } from '@earendil-works/pi-coding-agent';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
    throw new Error(
        'Missing API key. Set DEEPSEEK_API_KEY in .env/environment.',
    );
}

const modelId = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';

const modelRuntime = await ModelRuntime.create();
modelRuntime.registerProvider('deepseek', {
    baseUrl,
    apiKey,
});
await modelRuntime.setRuntimeApiKey('deepseek', apiKey);

const model = modelRuntime.getModel('deepseek', modelId);
if (!model) {
    throw new Error(`Model ${modelId} not found in provider deepseek`);
}

const inlineExtention: InlineExtension = {
    name: 'inline-extension',
    factory: (pi) => {
        pi.on("agent_start", () => {
            pi.events.emit('inline-extension:status', {
                a: 1,
                b: 2,
            })
            console.log("Agent started")
        });
    }
}

const eventBus = createEventBus();
eventBus.on('inline-extension:status', (data) => {
    console.log(data)
})


const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    eventBus,
    systemPromptOverride: (base) => `You are MyPi, a helpful assistant that help people handle daily tasks.`,
    appendSystemPrompt: ["Always answer in a concise Chinese."],
    extensionFactories: [
        (pi) => {
            pi.on("agent_start", () => {
                process.stdout.write("[demo-logger] agent_start\n");
            });
        },
        inlineExtention,
    ],
    // extensionsOverride: (base) => {
    //     return {
    //         ...base,
    //         extensions: [

    //         ]
    //     }
    // },
    additionalExtensionPaths: ["./04-tui.ts"],

    // extensionsOverride: (base) => {
    //     return {

    //     }
    // },
    // skillsOverride: (base) => {
    //     return {
    //         skills: [],
    //         diagnostics: []
    //     }
    // },

})
await loader.reload();

const { session } = await createAgentSession({
    model,
    modelRuntime,
    resourceLoader: loader,
});

session.subscribe((evt) => {
    switch (evt.type) {
        case 'tool_execution_start':
        case 'tool_execution_end':
            process.stdout.write(`${evt.type} ${evt.toolName} ${JSON.stringify(evt)}\n`)
    }
    if (evt.type === 'message_update' && evt.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(evt.assistantMessageEvent.delta);
    }
})

// await session.prompt('who are you')
await session.prompt('What is the current UTC time, and explain the timezone it uses.')