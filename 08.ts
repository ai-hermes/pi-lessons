import 'dotenv/config';
import { createAgentSession, ModelRuntime, DefaultResourceLoader, getAgentDir, createEventBus } from '@earendil-works/pi-coding-agent';
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

const eventBus = createEventBus();
eventBus.on('inline-extension:status', (data) => {
    process.stdout.write(`[Inline Extension] Status: ${JSON.stringify(data)}\n`);
});

const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    eventBus,
    // additionalExtensionPaths: ["./04-tui.ts"],
    extensionFactories: [
        (pi) => {
            pi.on("agent_start", () => {
                pi.events.emit("inline-extension:status", { status: "Agent starting" });
                process.stdout.write("[Inline Extension] Agent starting\n");
            });
            pi.on("tool_call", (evt) => {
                process.stdout.write(`[Inline Extension] Tool called: ${JSON.stringify(evt)}\n`);
                if(evt.toolName === "write") {
                    return {
                        block: true,
                        reason: "Blocking write tool by inline extension",
                    }
                }
            })
        },
    ]
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

await session.prompt(`What tools are available, and write it down in tools.md`);
process.stdout.write('\n');
