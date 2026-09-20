import type {
  ChatMessage,
  ConversationConfigUpdate,
  MessageListItem,
  StreamEvent,
} from "@shared/types";
import { useRef, useState, useEffect, useLayoutEffect, useReducer } from "react";
import { useNavigate } from "react-router-dom";

import {
  abortConversation,
  connectEvents,
  createConversation,
  getConversation,
  sendMessage,
  resolveBrowserHandoff,
  updateConversationConfig,
  openRemoteBrowser,
  closeRemoteBrowser,
  saveRemoteBrowser,
  loadRemoteBrowser,
} from "@/api";
import { browserPanelReducer, conversationReducer, createBrowserPanelState } from "@/state";

interface PendingSend {
  conversationId: string;
  text: string;
  message: ChatMessage;
  skills?: string[];
}

interface ConversationItemsState {
  conversationId?: string;
  items: MessageListItem[];
}

export function useConversationStream(conversationId?: string) {
  const navigate = useNavigate();
  const [messageState, setMessageState] = useState<ConversationItemsState>({
    items: [],
  });
  const [historyState, setHistoryState] = useState<ConversationItemsState>({
    items: [],
  });
  const [errorState, setErrorState] = useState<{
    conversationId?: string;
    message: string;
  }>({ message: "" });
  const [loading, setLoading] = useState(false);
  const [runtime, dispatch] = useReducer(
    browserPanelReducer,
    conversationId,
    createBrowserPanelState,
  );
  const [pendingActionIds, setPendingActionIds] = useState<ReadonlySet<string>>(() => new Set());
  const actionInFlight = useRef(new Set<string>());
  const resync = useRef<() => Promise<void>>(async () => {});
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const pendingSend = useRef<PendingSend | null>(null);
  const openIntent = useRef<string | undefined>(undefined);
  const routeRef = useRef(conversationId);
  useLayoutEffect(() => {
    routeRef.current = conversationId;
    openIntent.current = undefined;
    dispatch({ type: "select", conversationId });
  }, [conversationId]);

  const messageItems = [
    ...(historyState.conversationId === conversationId ? historyState.items : []),
    ...(messageState.conversationId === conversationId ? messageState.items : []),
  ];

  useEffect(() => {
    if (!conversationId) return;

    let disposed = false;
    let eventSource: EventSource | undefined;
    let streamOpen = false;
    let syncing = true;
    let syncVersion = 0;
    let buffered: StreamEvent[] = [];
    let cursor = { id: "", lastEventId: 0 };
    let runtimeEventId = 0;
    const receive = (event: StreamEvent) => {
      if (disposed) return;
      if (syncing) {
        buffered.push(event);
        return;
      }
      if (event.streamId !== cursor.id || event.id <= cursor.lastEventId) return;
      cursor = { id: event.streamId, lastEventId: event.id };
      // Replayed messages must not roll browser state back behind its latest snapshot.
      if (event.id > runtimeEventId) dispatch({ type: "event", conversationId, event });
      setMessageState((current) => ({
        conversationId,
        items: conversationReducer(current.conversationId === conversationId ? current.items : [], {
          type: "event",
          event,
        }),
      }));
    };
    const disconnect = () => {
      if (disposed) return;
      streamOpen = false;
      syncVersion++;
      syncing = true;
      buffered = [];
      dispatch({ type: "disconnect", conversationId });
      setErrorState({ conversationId, message: "连接中断，浏览器暂为只读，正在重新同步…" });
    };
    const sync = async () => {
      if (disposed || !streamOpen) return;
      const version = ++syncVersion;
      syncing = true;
      dispatch({ type: "disconnect", conversationId });
      try {
        const conversation = await getConversation(conversationId);
        if (disposed || version !== syncVersion) return;
        if (cursor.id !== conversation.stream.id) {
          setHistoryState({ conversationId, items: conversation.messageList });
          setMessageState({ conversationId, items: [] });
          cursor = conversation.stream;
        }
        runtimeEventId = conversation.stream.lastEventId;
        dispatch({ type: "snapshot", conversationId, snapshot: conversation });
        setSelectedSkills(conversation.activeSkillNames ?? []);
        setErrorState({ conversationId, message: "" });
        syncing = false;
        const events = buffered;
        buffered = [];
        events.forEach(receive);
      } catch (error) {
        if (disposed || version !== syncVersion) return;
        setErrorState({ conversationId, message: (error as Error).message });
        // Let EventSource retry instead of leaving an open but unsynchronized connection.
        eventSource?.close();
        streamOpen = false;
        retryTimer = setTimeout(connect, 2000);
      }
    };
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed) return;
      eventSource = connectEvents(
        conversationId,
        receive,
        disconnect,
        async () => {
          streamOpen = true;
          await sync();
          if (disposed || syncing) return;
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
          void send(conversationId, pending.text, pending.skills);
        },
        cursor.lastEventId,
      );
    };
    resync.current = sync;
    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      eventSource?.close();
    };
  }, [conversationId]);

  async function send(conversationId: string, text: string, skills?: string[]) {
    setLoading(true);
    setErrorState({
      conversationId,
      message: "",
    });

    try {
      await sendMessage(conversationId, text, skills);
    } catch (error) {
      setErrorState({
        conversationId,
        message: (error as Error)?.message || "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function submit(
    value: string,
    initialConfig?: ConversationConfigUpdate,
    skills?: string[],
  ) {
    const text = value.trim();
    if (!text || loading) return;

    const message: ChatMessage = {
      id: "pending-" + Date.now(),
      role: "user",
      text,
      images: [],
      timestamp: Date.now(),
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
        if (initialConfig?.model || initialConfig?.thinkingLevel !== undefined) {
          await updateConversationConfig(conversationId, initialConfig);
        }
        pendingSend.current = {
          conversationId,
          text,
          message,
          skills,
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
      items: conversationReducer(current.conversationId === conversationId ? current.items : [], {
        type: "optimistic-user",
        message,
      }),
    }));

    await send(conversationId, text, skills);
  }
  const status = runtime.conversationId === conversationId ? runtime.status : "cold";
  const error = errorState.conversationId === conversationId ? errorState.message : "";
  const historyLoading = Boolean(conversationId && historyState.conversationId !== conversationId);
  const connected = Boolean(
    conversationId && runtime.conversationId === conversationId && runtime.connected,
  );
  const actionPending = Boolean(conversationId && pendingActionIds.has(conversationId));
  const browserHandoff =
    runtime.conversationId === conversationId ? runtime.browserHandoff : undefined;
  async function browserAction(action: (id: string) => Promise<unknown>) {
    if (!conversationId || actionInFlight.current.has(conversationId)) return;
    const actionConversationId = conversationId;
    const refresh = resync.current;
    actionInFlight.current.add(actionConversationId);
    setPendingActionIds((current) => new Set(current).add(actionConversationId));
    setErrorState({ conversationId: actionConversationId, message: "" });
    try {
      await action(actionConversationId);
      await refresh();
    } catch (error) {
      await refresh();
      setErrorState({
        conversationId: actionConversationId,
        message: (error as Error)?.message || "Unknown error",
      });
    } finally {
      actionInFlight.current.delete(actionConversationId);
      setPendingActionIds((current) => {
        const next = new Set(current);
        next.delete(actionConversationId);
        return next;
      });
    }
  }
  const abort = () => browserAction(abortConversation);
  const resolveBrowserHandoffRequest = (action: "resume" | "cancel") =>
    browserHandoff
      ? browserAction((id) => resolveBrowserHandoff(id, browserHandoff.id, action))
      : Promise.resolve();
  return {
    messageItems,
    historyLoading,
    loading,
    error,
    send: submit,
    status,
    abort,
    browserHandoff,
    connected,
    actionPending,
    resolveBrowserHandoff: resolveBrowserHandoffRequest,
    browser: runtime.conversationId === conversationId ? runtime.browser : undefined,
    saveBrowser: () => browserAction(saveRemoteBrowser),
    loadBrowser: () => browserAction(loadRemoteBrowser),
    browserOpen: runtime.conversationId === conversationId && runtime.mode !== "closed",
    openBrowser: () => {
      if (!conversationId) return;
      openIntent.current = conversationId;
      dispatch({ type: "open", conversationId });
      void browserAction(async (id) => {
        await openRemoteBrowser(id);
        // A slow provisioning response must not keep an abandoned manual browser alive.
        if (openIntent.current !== id || routeRef.current !== id) await closeRemoteBrowser(id);
      });
    },
    closeBrowser: async () => {
      openIntent.current = undefined;
      if (conversationId) {
        try {
          await closeRemoteBrowser(conversationId);
        } catch (error) {
          setErrorState({ conversationId, message: (error as Error).message });
          return false;
        }
      }
      dispatch({ type: "close", conversationId });
      return true;
    },
    selectedSkills,
    setSelectedSkills,
  };
}
