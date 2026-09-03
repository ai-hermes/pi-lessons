import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ChatMessage,
  MessageListItem,
  StreamEvent,
} from "@shared/types";
import { playMockConversation } from "../mock/conversation";
import { conversationReducer } from "../state";

export function useConversationStream(conversationId?: string) {
  const navigate = useNavigate();
  const [messageState, setMessageState] = useState<{
    conversationId?: string;
    items: MessageListItem[];
  }>({ items: [] });
  const [loading, setLoading] = useState(false);
  const runId = useRef(0);

  const messageItems =
    messageState.conversationId === conversationId ? messageState.items : [];

  function appendEvent(id: string, event: StreamEvent) {
    setMessageState((current) => ({
      conversationId: id,
      items: conversationReducer(
        current.conversationId === id ? current.items : [],
        { type: "event", event },
      ),
    }));
  }

  async function submit(value: string) {
    const text = value.trim();
    if (!text || loading) return;

    const id = conversationId ?? crypto.randomUUID();
    const currentRun = ++runId.current;
    const message: ChatMessage = {
      id: "pending-" + currentRun,
      role: "user",
      text,
      images: [],
      pending: true,
    };

    setMessageState((current) => ({
      conversationId: id,
      items: conversationReducer(
        current.conversationId === id ? current.items : [],
        { type: "optimistic-user", message },
      ),
    }));
    setLoading(true);
    if (!conversationId) navigate("/conversation/" + id);

    try {
      await playMockConversation(
        text,
        (event) => appendEvent(id, event),
        () => currentRun !== runId.current,
      );
    } finally {
      if (currentRun === runId.current) setLoading(false);
    }
  }

  return { messageItems, loading, error: "", send: submit };
}
