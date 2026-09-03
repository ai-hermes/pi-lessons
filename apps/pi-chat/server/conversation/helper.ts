import type {
    ImageContent,
    TextContent,
    ThinkingContent,
    ToolCall,
} from "@earendil-works/pi-ai";
import { type SessionEntry, type SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { ChatImage, ChatMessage, MessageListItem, MessageListToolItem, ThinkingBlock, ToolRun } from "@shared/types";
type ContentPart =
    | TextContent
    | ThinkingContent
    | ImageContent
    | ToolCall;

type SessionMessage = SessionMessageEntry["message"];
type ConversationMessage = Extract<
    SessionMessage,
    { role: "user" | "assistant" }
>;
type AgentToolResultMessage = Extract<
    SessionMessage,
    { role: "toolResult" }
>;


/** Narrows a content part to an image with the required fields. */
export function isImagePart(
    part: ContentPart,
): part is ImageContent & {
    data: string;
    mimeType: string;
} {
    return (
        part.type === "image" &&
        Boolean(part.data) &&
        Boolean(part.mimeType)
    );
}

export function resultText(result: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
    return result?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}

function normalizeContent(
    content: string | ContentPart[],
): ContentPart[] {
    if (typeof content === "string") {
        return [
            {
                type: "text",
                text: content,
            },
        ];
    }

    return content;
}

function extractText(
    content: ContentPart[],
): string {
    return content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}

function extractImages(
    content: ContentPart[],
): ChatImage[] {
    return content
        .filter(isImagePart)
        .map((part) => ({
            type: "image",
            data: part.data,
            mimeType: part.mimeType,
        }));
}


export class ConversationViewBuilder {
    private readonly entries: SessionEntry[];
    private readonly messageList: MessageListItem[] = [];
    private readonly toolsByCallId = new Map<string, MessageListToolItem>();

    constructor(entries: SessionEntry[]) {
        this.entries = entries;
    }

    build(): MessageListItem[] {
        for (const entry of this.entries) {
            this.processEntry(entry);
        }
        return this.messageList
    }

    private processEntry(entry: SessionEntry) {
        if (entry.type !== 'message') return;

        const message = entry.message;
        if (message.role === 'user') {
            this.addUserMessage(entry, message);
            return
        }
        if (message.role === 'assistant') {
            this.addAssistantMessage(entry, message);
            return
        }
        if (message.role === 'toolResult') {
            this.updateToolResult(message);
            return
        }
    }

    private addUserMessage(
        entry: SessionMessageEntry,
        message: Extract<ConversationMessage, { role: "user" }>,
    ) {
        const content = normalizeContent(message.content);
        const chatMessage: ChatMessage = {
            id: entry.id,
            role: "user",
            text: extractText(content),
            images: extractImages(content),
        };
        this.messageList.push({
            kind: 'message',
            id: entry.id,
            message: chatMessage,
        });
    }

    private addAssistantMessage(
        entry: SessionMessageEntry,
        message: Extract<ConversationMessage, { role: "assistant" }>,
    ) {
        const content = normalizeContent(message.content);
        const text = extractText(content);
        const chatMessage: ChatMessage = {
            id: entry.id,
            role: "assistant",
            text,
            images: extractImages(content),
            ...(message.errorMessage ? { error: message.errorMessage } : {}),
        }

        let thinkingBlock: ThinkingBlock | undefined;
        let messageAdded = false;
        for (const part of content) {
            if (part.type === "thinking") {
                if (!thinkingBlock) {
                    thinkingBlock = {
                        id: entry.id + ":thinking",
                        text: "",
                    };
                    this.messageList.push({
                        kind: "thinking",
                        id: thinkingBlock.id,
                        thinking: thinkingBlock,
                    });
                }
                thinkingBlock.text += part.thinking ?? "";
                continue;
            }

            if (part.type === 'toolCall' && part.id) {
                // tool call (start)
                // tool call (end + result)
                if (!part.name) return
                const tool: ToolRun = {
                    id: part.id,
                    name: part.name,
                    args: part.arguments ?? {},
                    status: "running",
                };
                const toolItem: MessageListToolItem = {
                    kind: "tool",
                    id: tool.id,
                    tool,
                };
                this.toolsByCallId.set(part.id, toolItem)
                this.messageList.push(toolItem)
            }

            if (
                part.type === 'text' &&
                (text.length > 0 || Boolean(message.errorMessage)) &&
                !messageAdded
            ) {
                messageAdded = true;
                this.messageList.push({
                    kind: 'message',
                    id: entry.id,
                    message: chatMessage,
                });
            }
        }
        if (Boolean(message.errorMessage) && !messageAdded) {
            this.messageList.push({ kind: "message", id: entry.id, message: chatMessage });
        }
    }


    private updateToolResult(
        message: AgentToolResultMessage,
    ) {
        const toolCallId = message.toolCallId;
        if (!toolCallId) return;

        const item = this.toolsByCallId.get(toolCallId);
        if (!item) return;

        const tool: ToolRun = {
            id: toolCallId,
            name: message.toolName ?? item.tool.name,
            args: item.tool.args,
            status: message.isError ? "error" : "success",
            result: extractText(message.content),
            details: message.details,
        };
        item.tool = tool
    }

}