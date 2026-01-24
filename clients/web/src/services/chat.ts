import type { Message, Permissions, ServerEvent } from "../types";

export interface ChatRequest {
  model: string;
  messages: Message[];
  permissions?: Permissions;
}

export async function* streamChat(
  request: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<ServerEvent> {
  const response = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      permissions: request.permissions,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const events = buffer.split("\n\n");
      // Keep the last part in buffer (may be incomplete)
      buffer = events.pop() ?? "";

      for (const eventBlock of events) {
        if (!eventBlock.trim()) continue;

        let data = "";
        for (const line of eventBlock.split("\n")) {
          if (line.startsWith("data: ")) {
            data = line.slice(6);
          }
        }

        if (data) {
          try {
            const event = JSON.parse(data) as ServerEvent;
            yield event;
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
