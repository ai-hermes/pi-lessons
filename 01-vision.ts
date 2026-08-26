import 'dotenv/config';
import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';


const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY environment variable is not set');
}

const modelName = 'deepseek-v4-flash-vision-exp';

const modelRuntime = await ModelRuntime.create();
modelRuntime.registerProvider('deepseek', {
    baseUrl: 'https://api.deepseek.com',
    apiKey,
    models: [
        {
            "id": modelName,
            "name": "DeepSeek V4 Flash Vision(Experimental)",
            "api": "openai-completions",
            "baseUrl": "https://api.deepseek.com",
            "reasoning": true,
            "input": [
                "text", "image"
            ],
            "cost": {
                "input": 0.14,
                "output": 0.28,
                "cacheRead": 0.0028,
                "cacheWrite": 0
            },
            "contextWindow": 1000000,
            "maxTokens": 384000,
            "compat": {
                "supportsStore": false,
                "supportsDeveloperRole": false,
                "maxTokensField": "max_tokens",
                "requiresReasoningContentOnAssistantMessages": true,
                "thinkingFormat": "deepseek"
            },
            "thinkingLevelMap": {
                "minimal": null,
                "low": "low",
                "medium": null,
                "high": "high",
                "max": "max"
            }
        }
    ]
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

const imagePath = join(process.cwd(), 'fat-cat.png');
const imageBubffer = await readFile(imagePath)
const b64Data = imageBubffer.toString('base64')

function detectMimeType(filePath: string): string {
    const extension = extname(filePath).toLowerCase();
    switch (extension) {
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.png':
            return 'image/png';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        default:
            throw new Error(`Unsupported image format: ${extension}`);
    }
}

await session.prompt('Please describe the image in Chinese', {
    images: [
        {
            type: 'image',
            data: b64Data,
            mimeType: detectMimeType(imagePath),
        }
    ]
})
process.stdout.write('\n');