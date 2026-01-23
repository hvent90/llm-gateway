import type { Message, ServerEvent } from "../types";

export interface ChatRequest {
  model: string;
  messages: Message[];
  permissions?: string[];
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
      permissions: request.permissions
        ? { allowlist: request.permissions.map((tool) => ({ tool })) }
        : undefined,
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

      // Parse SSE events
      const lines = buffer.split("\n");
      buffer = "";

      let eventType = "";
      let data = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("data: ")) {
          data = line.slice(6);
        } else if (line === "" && data) {
          try {
            const event = JSON.parse(data) as ServerEvent;
            yield event;
          } catch {
            // Skip invalid JSON
          }
          eventType = "";
          data = "";
        } else if (line !== "") {
          // Incomplete line, keep in buffer
          buffer = line;
        }
      }

      // Keep partial event in buffer
      if (eventType || data) {
        if (eventType) buffer += `event: ${eventType}\n`;
        if (data) buffer += `data: ${data}\n`;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
