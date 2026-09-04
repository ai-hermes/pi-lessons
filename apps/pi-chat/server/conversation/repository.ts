import type { GlobalConfig } from '@server/config';
import type { ConversationRecord } from './types';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'

export class ConversationRepository {
    private readonly globalConfig: GlobalConfig;

    constructor(globalConfig: GlobalConfig) {
        this.globalConfig = globalConfig;
    }

    recordPath(conversationId: string) {
        return join(this.globalConfig.recordsDir, `${conversationId}.json`)
    }

    async save(conversationRecord: ConversationRecord) {
        const conversationRecordPath = this.recordPath(conversationRecord.id);
        await mkdir(this.globalConfig.recordsDir, { recursive: true });
        await writeFile(conversationRecordPath, JSON.stringify(conversationRecord, null, 2));
    }

    async get(conversationId: string): Promise<ConversationRecord | null> {
        const conversationRecordPath = this.recordPath(conversationId);
        try {
            const data = await readFile(conversationRecordPath, 'utf-8');
            return JSON.parse(data) as ConversationRecord;
        } catch {
            return null;
        }
    }

    async update(conversationId: string, updatedConversationRecord: Partial<ConversationRecord>) {
        const existingConversationRecord = await this.get(conversationId)
        if (!existingConversationRecord) {
            throw new Error(`Conversation with ID ${conversationId} not found`);
        }
        const mergedConversationRecord: ConversationRecord = {
            ...existingConversationRecord,
            ...updatedConversationRecord,
            updatedAt: new Date(),
        };
        await this.save(mergedConversationRecord);
    }

    async delete(conversationId: string) {
        const conversationRecordPath = this.recordPath(conversationId);
        await rm(conversationRecordPath, { force: true });
    }

}
