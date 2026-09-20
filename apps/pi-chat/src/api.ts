import type {
  BootstrapData,
  BrowserState,
  ConversationConfig,
  ConversationConfigUpdate,
  ConversationSnapshot,
  ConversationSummary,
  CreateConversationResponse,
  StreamEvent,
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

export function getBootstrap(): Promise<BootstrapData> {
  return readResponse(fetch("/api/system/bootstrap"));
}

export function sendMessage(id: string, text: string, skills: string[] = []): Promise<unknown> {
  const form = new FormData();
  form.set("text", text);
  form.set("skills", JSON.stringify(skills));
  return readResponse(
    fetch("/api/conversation/" + encodeURIComponent(id) + "/messages", {
      method: "POST",
      body: form,
    }),
  );
}

export function getConversation(id: string): Promise<ConversationSnapshot> {
  return readResponse(
    fetch("/api/conversation/" + encodeURIComponent(id), {
      signal: AbortSignal.timeout(15_000),
    }),
  );
}

export function connectEvents(
  id: string,
  onEvent: (event: StreamEvent) => void,
  onError: () => void,
  onOpen?: () => void,
  after = 0,
): EventSource {
  const query = new URLSearchParams({ after: String(after) });
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

export function renameConversation(id: string, title: string): Promise<ConversationSummary> {
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

export function resolveBrowserHandoff(id: string, requestId: string, action: "resume" | "cancel") {
  return readResponse(
    fetch(
      `/api/conversation/${encodeURIComponent(id)}/browser/handoff/${encodeURIComponent(requestId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      },
    ),
  );
}

export function openRemoteBrowser(id: string) {
  return readResponse<{ browser: BrowserState }>(
    fetch(`/api/conversation/${encodeURIComponent(id)}/browser/open`, { method: "POST" }),
  );
}

export function closeRemoteBrowser(id: string) {
  return readResponse(
    fetch(`/api/conversation/${encodeURIComponent(id)}/browser/close`, {
      method: "POST",
      keepalive: true,
    }),
  );
}

export function saveRemoteBrowser(id: string) {
  return readResponse(
    fetch(`/api/conversation/${encodeURIComponent(id)}/browser/save`, { method: "POST" }),
  );
}

export function loadRemoteBrowser(id: string) {
  return readResponse(
    fetch(`/api/conversation/${encodeURIComponent(id)}/browser/load`, { method: "POST" }),
  );
}

export function getConversationConfig(id: string): Promise<ConversationConfig> {
  return readResponse(fetch("/api/conversation/" + encodeURIComponent(id) + "/config"));
}

export function updateConversationConfig(
  id: string,
  update: ConversationConfigUpdate,
): Promise<ConversationConfig> {
  return readResponse(
    fetch("/api/conversation/" + encodeURIComponent(id) + "/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
}
