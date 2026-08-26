import 'dotenv/config';
import { createAgentSession, ModelRuntime, DefaultResourceLoader, getAgentDir} from '@earendil-works/pi-coding-agent';

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


// .pi/skills/
// ~/.pi/skills
const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    // skillsOverride: (current) => ({
    //     skills: [
    //         typescriptExpertSkill
    //     ],
    //     diagnostics: current.diagnostics,
    // }),
});
await loader.reload();

process.stdout.write('Loaded skills:\n');
const { skills } = loader.getSkills()
for (const skill of skills) {
    process.stdout.write(`- ${skill.name}: ${skill.description}\n`);
}

/*
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


const problematicCode = `
function getData(id) {
  var url = "https://api.example.com/users/" + id;
  var res = fetch(url);
  return res.json();
}
`;

await session.prompt(`请审阅一下代码\n\n${problematicCode}`);
process.stdout.write('\n');
*/
