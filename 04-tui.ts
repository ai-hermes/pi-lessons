import 'dotenv/config';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";



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


export default function (pi: ExtensionAPI) {
    pi.registerTool(customUTCTimeTool);
}
