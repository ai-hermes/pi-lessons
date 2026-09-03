import { Hono } from 'hono';
export function createConversationRoutes() {
    const conversationApp = new Hono();

    conversationApp.post('/', async () => {
        throw new Error("Not implemented");
    })

    conversationApp.get('/:id', async () => {
        throw new Error("Not implemented");
    })

    conversationApp.post('/:conversationId/messages', async () => {
        throw new Error("Not implemented");
    })

    conversationApp.get('/:conversationId/stream', () => {
        throw new Error("Not implemented");
    })

    return conversationApp;
}
