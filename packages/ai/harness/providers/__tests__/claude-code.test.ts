import { describe, test, expect } from "bun:test";
import { serializeMessages, parseNDJSON, mapStreamEvent, createGeneratorHarness } from "../claude-code";
import type { HarnessEvent, Message } from "../../../types";

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

describe("parseNDJSON", () => {
  test("parses complete lines from ReadableStream", async () => {
    const lines = ['{"type":"a","data":1}', '{"type":"b","data":2}'];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines.join("\n") + "\n"));
        controller.close();
      },
    });

    const parsed: unknown[] = [];
    for await (const obj of parseNDJSON(input)) {
      parsed.push(obj);
    }

    expect(parsed).toEqual([
      { type: "a", data: 1 },
      { type: "b", data: 2 },
    ]);
  });

  test("handles chunked delivery across line boundaries", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('{"typ'));
        controller.enqueue(enc.encode('e":"x"}\n{"ty'));
        controller.enqueue(enc.encode('pe":"y"}\n'));
        controller.close();
      },
    });

    const parsed: unknown[] = [];
    for await (const obj of parseNDJSON(input)) {
      parsed.push(obj);
    }

    expect(parsed).toEqual([{ type: "x" }, { type: "y" }]);
  });

  test("skips malformed JSON lines", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"type":"a"}\nnot-json\n{"type":"b"}\n'),
        );
        controller.close();
      },
    });

    const parsed: unknown[] = [];
    for await (const obj of parseNDJSON(input)) {
      parsed.push(obj);
    }

    expect(parsed).toEqual([{ type: "a" }, { type: "b" }]);
  });

  test("skips empty lines", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('\n{"type":"a"}\n\n'));
        controller.close();
      },
    });

    const parsed: unknown[] = [];
    for await (const obj of parseNDJSON(input)) {
      parsed.push(obj);
    }

    expect(parsed).toEqual([{ type: "a" }]);
  });
});

describe("mapStreamEvent", () => {
  const ctx = { runId: "run-1", textId: "txt-1", reasoningId: "rsn-1" };

  test("maps text_delta to text event", () => {
    const event = {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    };
    const result = mapStreamEvent(event, ctx);
    expect(result).toEqual({
      type: "text",
      runId: "run-1",
      id: "txt-1",
      content: "hello",
    });
  });

  test("maps thinking_delta to reasoning event", () => {
    const event = {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "let me think" },
    };
    const result = mapStreamEvent(event, ctx);
    expect(result).toEqual({
      type: "reasoning",
      runId: "run-1",
      id: "rsn-1",
      content: "let me think",
    });
  });

  test("returns null for ignored event types", () => {
    expect(mapStreamEvent({ type: "message_start" }, ctx)).toBeNull();
    expect(mapStreamEvent({ type: "content_block_start" }, ctx)).toBeNull();
    expect(mapStreamEvent({ type: "content_block_stop" }, ctx)).toBeNull();
    expect(mapStreamEvent({ type: "message_stop" }, ctx)).toBeNull();
  });

  test("returns null for input_json_delta (tool use — should not happen)", () => {
    const event = {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{}" },
    };
    expect(mapStreamEvent(event, ctx)).toBeNull();
  });

  test("applies parentId when provided", () => {
    const event = {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hi" },
    };
    const result = mapStreamEvent(event, { ...ctx, parentId: "parent-1" });
    expect(result).toEqual({
      type: "text",
      runId: "run-1",
      id: "txt-1",
      content: "hi",
      parentId: "parent-1",
    });
  });
});

describe("Claude Code Generator Harness", () => {
  test("implements GeneratorHarnessModule interface", () => {
    const harness = createGeneratorHarness();
    expect(typeof harness.invoke).toBe("function");
    expect(typeof harness.supportedModels).toBe("function");
  });

  test("supportedModels returns known Claude models", async () => {
    const harness = createGeneratorHarness();
    const models = await harness.supportedModels();
    expect(models).toContain("claude-sonnet-4-6");
    expect(models).toContain("claude-opus-4-6");
    expect(models).toContain("claude-haiku-4-5");
  });

  test("invoke yields error when no model specified", async () => {
    const harness = createGeneratorHarness();
    const events: HarnessEvent[] = [];
    for await (const e of harness.invoke({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(e);
    }
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    // runId should be a valid UUID, not a placeholder
    expect(errors[0]!.runId).toMatch(/^[0-9a-f-]+$/);
  });
});
