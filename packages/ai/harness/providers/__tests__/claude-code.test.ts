import { describe, test, expect } from "bun:test";
import { serializeMessages } from "../claude-code";
import type { Message } from "../../../types";

describe("serializeMessages", () => {
  test("extracts system message and returns single user message as-is", () => {
    const messages: Message[] = [
      { role: "system", content: "You are a REPL assistant." },
      { role: "user", content: "Hello world" },
    ];
    const { systemPrompt, prompt } = serializeMessages(messages);
    expect(systemPrompt).toBe("You are a REPL assistant.");
    expect(prompt).toBe("Hello world");
  });

  test("serializes multi-turn history with XML role markers", () => {
    const messages: Message[] = [
      { role: "system", content: "System prompt here." },
      { role: "user", content: "Find bugs" },
      { role: "assistant", content: "```js\nconsole.log(1)\n```" },
      { role: "user", content: "stdout: 1" },
    ];
    const { systemPrompt, prompt } = serializeMessages(messages);
    expect(systemPrompt).toBe("System prompt here.");
    expect(prompt).toContain("<user>\nFind bugs\n</user>");
    expect(prompt).toContain("<assistant>\n```js\nconsole.log(1)\n```\n</assistant>");
    expect(prompt).toContain("<user>\nstdout: 1\n</user>");
  });

  test("handles no system message", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
    ];
    const { systemPrompt, prompt } = serializeMessages(messages);
    expect(systemPrompt).toBeUndefined();
    expect(prompt).toBe("Hello");
  });

  test("handles assistant message with null content", () => {
    const messages: Message[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: null },
      { role: "user", content: "Continue" },
    ];
    const { systemPrompt, prompt } = serializeMessages(messages);
    expect(prompt).toContain("<assistant>\n\n</assistant>");
  });
});
