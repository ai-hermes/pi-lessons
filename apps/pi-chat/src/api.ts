import type {
  CreateConversationResponse,
  StreamEvent,
  ConversationSnapshot,
  ConversationSummary,
} from "@shared/types";

async function readResponse<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? response.status + " " + response.statusText);
  }
  return (await response.json()) as T;
}

export function createConversation(): Promise<CreateConversationResponse> {
  return readResponse(fetch("/api/conversation", { method: "POST" }));
}

export function sendMessage(id: string, text: string): Promise<unknown> {
  const form = new FormData();
  form.set("text", text);
  return readResponse(
    fetch("/api/conversation/" + encodeURIComponent(id) + "/messages", {
      method: "POST",
      body: form,
    }),
  );
}

export function getConversation(id: string): Promise<ConversationSnapshot> {
  return readResponse(fetch("/api/conversation/" + encodeURIComponent(id)));
}

export function connectEvents(
  id: string,
  onEvent: (event: StreamEvent) => void,
  onError: () => void,
  onOpen?: () => void,
): EventSource {
  const query = new URLSearchParams({ after: "0" });
  const source = new EventSource(
    "/api/conversation/" + encodeURIComponent(id) + "/stream?" + query,
  );
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as StreamEvent);
    } catch {
      onError();
    }
  };
  source.onerror = onError;
  source.onopen = () => onOpen?.();
  return source;
}

export function listConversations(): Promise<ConversationSummary[]> {
  return readResponse(fetch("/api/conversation"));
}


export function deleteConversation(id: string): Promise<{ deleted: true }> {
  return readResponse(
    fetch("/api/conversation/" + encodeURIComponent(id), {
      method: "DELETE",
    }),
  );
}


export function renameConversation(
  id: string,
  title: string,
): Promise<ConversationSummary> {
  return readResponse(
    fetch("/api/conversation/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
}


export function abortConversation(id: string): Promise<{ aborted: true }> {
  return readResponse(
    fetch("/api/conversation/" + encodeURIComponent(id) + "/abort", {
      method: "POST",
    }),
  );
}
