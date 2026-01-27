import type { ServerEvent, StreamRequest } from "../server-event";

/**
 * Result of parsing a buffer of SSE-formatted text.
 */
interface ParseResult {
  events: ServerEvent[];
  remaining: string;
}

/**
 * Parse SSE-formatted text into ServerEvents.
 * Returns parsed events and any incomplete trailing data for buffering.
 */
function parseSSE(buffer: string): ParseResult {
  const events: ServerEvent[] = [];
  const blocks = buffer.split("\n\n");
  const remaining = blocks.pop() ?? "";

  for (const block of blocks) {
    if (!block.trim()) continue;

    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) {
        data += line.slice(6);
      }
    }

    if (data) {
      try {
        events.push(JSON.parse(data) as ServerEvent);
      } catch {
        // Skip invalid JSON
      }
    }
  }

  return { events, remaining };
}

/**
 * Create an SSE transport for streaming server events.
 */
export function createSSETransport(config: { baseUrl: string }) {
  const { baseUrl } = config;

  return {
    async *stream(request: StreamRequest, signal?: AbortSignal): AsyncGenerator<ServerEvent> {
      const response = await fetch(`${baseUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
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
          const { events, remaining } = parseSSE(buffer);
          buffer = remaining;

          for (const event of events) {
            yield event;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
