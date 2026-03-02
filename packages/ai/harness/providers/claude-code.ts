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
