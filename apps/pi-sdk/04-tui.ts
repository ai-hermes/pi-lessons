import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from "typebox";

const utcTimeTool = defineTool({
    name: 'utc_time',
    label: 'utc_time',
    description: 'return the current UTC ISO timestamp',
    parameters: Type.Object({}),
    execute: async () => {
        return {
            content: [
                {
                    type: 'text',
                    text: new Date().toISOString(),
                }
            ],
            details: {},
        };
    }
})


export default (pi: ExtensionAPI) => {
    pi.registerTool(utcTimeTool);
}