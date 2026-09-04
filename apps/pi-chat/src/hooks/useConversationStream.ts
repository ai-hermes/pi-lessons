import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { ChatMessage, MessageListItem } from "@shared/types";
import { conversationReducer } from "@/state";
import {
  connectEvents,
  createConversation,
  getConversation,
  sendMessage,
} from "@/api";

interface PendingSend {
  conversationId: string;
  text: string;
  message: ChatMessage;
}

export function useConversationStream(conversationId?: string) {
  const navigate = useNavigate();
  const [messageState, setMessageState] = useState<{
    conversationId?: string;
    items: MessageListItem[];
  }>({ items: [] });
  const [historyMessageList, setHistoryMessageList] = useState<
    MessageListItem[]
  >([]);
  const [errorState, setErrorState] = useState<{
    conversationId?: string;
    message: string;
  }>({ message: "" });
  const [loading, setLoading] = useState(false);
  const pendingSend = useRef<PendingSend | null>(null);

  const messageItems = [
    ...historyMessageList,
    ...(messageState.conversationId === conversationId
      ? messageState.items
      : []),
  ];

  useEffect(() => {
    if (!conversationId) return;

    (async () => {
      const conversation = await getConversation(conversationId);
      setHistoryMessageList(conversation.messageList);
      connectEvents(
        conversationId,
        (event) => {
          setMessageState((current) => {
            return {
              conversationId,
              items: conversationReducer(
                current.conversationId === conversationId ? current.items : [],
                {
                  type: "event",
                  event,
                },
              ),
            };
          });
        },
        () => {
          setErrorState({
            conversationId,
            message: "Connection error",
          });
        },
        () => {
          // Handle connection open event
          const pending = pendingSend.current;
          if (!pending || pending.conversationId !== conversationId) return;
          pendingSend.current = null;

          setMessageState((current) => ({
            conversationId,
            items: conversationReducer(
              current.conversationId === conversationId ? current.items : [],
              { type: "optimistic-user", message: pending.message },
            ),
          }));

          send(conversationId, pending.text);
        },
      );
    })();
  }, [conversationId]);

  async function send(conversationId: string, text: string) {
    setLoading(true);
    setErrorState({
      conversationId,
      message: "",
    });

    try {
      await sendMessage(conversationId, text);
    } catch (error) {
      setErrorState({
        conversationId,
        message: (error as Error)?.message || "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function submit(value: string) {
    const text = value.trim();
    if (!text || loading) return;

    const message: ChatMessage = {
      id: "pending-" + Date.now(),
      role: "user",
      text,
      images: [],
      pending: true,
    };
    if (!conversationId) {
      setLoading(true);
      setErrorState({
        message: "",
      });
      try {
        const created = await createConversation();
        const conversationId = created.conversation.id;
        pendingSend.current = {
          conversationId,
          text,
          message,
        };
        navigate(`/conversation/${conversationId}`);
      } catch (error) {
        setErrorState({
          message: (error as Error)?.message || "Unknown error",
        });
      } finally {
        setLoading(false);
      }

      return;
    }

    setMessageState((current) => ({
      conversationId,
      items: conversationReducer(
        current.conversationId === conversationId ? current.items : [],
        { type: "optimistic-user", message },
      ),
    }));

    await send(conversationId, text);
  }

  return { messageItems, loading, error: errorState.message, send: submit };
}
