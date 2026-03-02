import type { Message } from "../../types";

/**
 * Separate system message from conversation and serialize remaining
 * messages into a prompt string with XML role markers.
 */
export function serializeMessages(messages: Message[]): {
  systemPrompt: string | undefined;
  prompt: string;
} {
  let systemPrompt: string | undefined;
  const nonSystem: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = msg.content;
    } else {
      nonSystem.push(msg);
    }
  }

  // Single user message — pass through directly
  if (nonSystem.length === 1 && nonSystem[0]!.role === "user") {
    const content = nonSystem[0]!.content;
    return {
      systemPrompt,
      prompt: typeof content === "string" ? content : JSON.stringify(content),
    };
  }

  // Multi-turn — wrap each message in XML role tags
  const parts: string[] = [];
  for (const msg of nonSystem) {
    const content =
      msg.role === "assistant"
        ? (msg.content ?? "")
        : typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
    parts.push(`<${msg.role}>\n${content}\n</${msg.role}>`);
  }

  return { systemPrompt, prompt: parts.join("\n\n") };
}

/**
 * Parse newline-delimited JSON from a ReadableStream.
 * Skips empty lines and malformed JSON (same resilience as Zen's SSE parser).
 */
export async function* parseNDJSON(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          continue; // skip malformed lines
        }
      }
    }

    // Handle any remaining content in buffer
    const trimmed = buffer.trim();
    if (trimmed) {
      try {
        yield JSON.parse(trimmed);
      } catch {
        // skip
      }
    }
  } finally {
    reader.releaseLock();
  }
}
