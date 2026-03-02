# Claude Code Provider Harness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a provider harness that wraps `claude -p` CLI so model calls route through a Claude Max subscription.

**Architecture:** Spawn `claude -p` via `Bun.spawn` per `invoke()` call. Serialize gateway `Message[]` into a prompt string with XML role markers. Parse NDJSON stdout (`--output-format stream-json`) and map stream events to `HarnessEvent`. No tools, no agent loop — pure text-in/text-out.

**Tech Stack:** Bun (spawn, streams), Claude Code CLI

---

### Task 1: serializeMessages utility

**Files:**
- Create: `packages/ai/harness/providers/claude-code.ts`
- Test: `packages/ai/harness/providers/__tests__/claude-code.test.ts`

**Step 1: Write the failing tests**

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: FAIL — `serializeMessages` does not exist

**Step 3: Write minimal implementation**

In `packages/ai/harness/providers/claude-code.ts`:

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/harness/providers/claude-code.ts packages/ai/harness/providers/__tests__/claude-code.test.ts
git commit -m "feat(claude-code): add message serialization for claude -p"
```

---

### Task 2: NDJSON stream parser

**Files:**
- Modify: `packages/ai/harness/providers/claude-code.ts`
- Test: `packages/ai/harness/providers/__tests__/claude-code.test.ts`

**Step 1: Write the failing tests**

Append to the test file:

```typescript
import { parseNDJSON } from "../claude-code";

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
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: FAIL — `parseNDJSON` does not exist

**Step 3: Write minimal implementation**

Add to `claude-code.ts`:

```typescript
/**
 * Parse newline-delimited JSON from a ReadableStream.
 * Skips empty lines and malformed JSON (same resilience as Zen's SSE parser).
 */
export async function* parseNDJSON(stream: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
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
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/harness/providers/claude-code.ts packages/ai/harness/providers/__tests__/claude-code.test.ts
git commit -m "feat(claude-code): add NDJSON stream parser"
```

---

### Task 3: mapStreamEvent utility

**Files:**
- Modify: `packages/ai/harness/providers/claude-code.ts`
- Test: `packages/ai/harness/providers/__tests__/claude-code.test.ts`

**Step 1: Write the failing tests**

Append to test file:

```typescript
import { mapStreamEvent } from "../claude-code";
import type { HarnessEvent } from "../../../types";

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
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: FAIL — `mapStreamEvent` does not exist

**Step 3: Write minimal implementation**

Add to `claude-code.ts`:

```typescript
import type { HarnessEvent } from "../../types";

interface MapContext {
  runId: string;
  textId: string;
  reasoningId: string;
  parentId?: string;
}

/**
 * Map a raw Claude API stream event to a HarnessEvent, or null if ignored.
 */
export function mapStreamEvent(event: Record<string, any>, ctx: MapContext): HarnessEvent | null {
  if (event.type !== "content_block_delta") return null;

  const delta = event.delta;
  if (!delta) return null;

  const tag = <T extends object>(e: T): T & { parentId?: string } =>
    ctx.parentId ? { ...e, parentId: ctx.parentId } : e;

  if (delta.type === "text_delta" && delta.text) {
    return tag({ type: "text" as const, runId: ctx.runId, id: ctx.textId, content: delta.text });
  }

  if (delta.type === "thinking_delta" && delta.thinking) {
    return tag({
      type: "reasoning" as const,
      runId: ctx.runId,
      id: ctx.reasoningId,
      content: delta.thinking,
    });
  }

  return null;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/harness/providers/claude-code.ts packages/ai/harness/providers/__tests__/claude-code.test.ts
git commit -m "feat(claude-code): add stream event mapper"
```

---

### Task 4: createGeneratorHarness — the main provider

**Files:**
- Modify: `packages/ai/harness/providers/claude-code.ts`
- Test: `packages/ai/harness/providers/__tests__/claude-code.test.ts`

This is the core integration task. We wire up `Bun.spawn`, the NDJSON parser, the event mapper, and usage extraction into the `GeneratorHarnessModule` interface.

**Step 1: Write the failing tests**

Append to test file:

```typescript
import { createGeneratorHarness } from "../claude-code";

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

  test("invoke throws when no model specified", async () => {
    const harness = createGeneratorHarness();
    const events: HarnessEvent[] = [];
    for await (const e of harness.invoke({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(e);
    }
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: FAIL — `createGeneratorHarness` does not exist

**Step 3: Write the implementation**

Add to `claude-code.ts`:

```typescript
import { v7 } from "uuid";
import type { GeneratorHarnessModule, GeneratorInvokeParams } from "../../types";
import { log } from "../../logger";

interface ClaudeCodeHarnessOptions {
  model?: string;
  cliPath?: string;
}

function createGeneratorHarness(options?: ClaudeCodeHarnessOptions): GeneratorHarnessModule {
  const defaultModel = options?.model;
  const cliPath = options?.cliPath ?? "claude";

  return {
    async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const model = params.model ?? defaultModel;
      if (!model) {
        yield {
          type: "error" as const,
          runId: "no-model",
          error: new Error("No model specified: provide model at harness creation or invoke time"),
        };
        return;
      }

      const runId = v7();
      const parentId = params.env?.parentId;
      const textId = v7();
      const reasoningId = v7();

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      const { systemPrompt, prompt } = serializeMessages(params.messages);

      const args = [
        cliPath,
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--model", model,
      ];

      if (systemPrompt) {
        args.push("--system-prompt", systemPrompt);
      }

      // Disable all built-in tools
      args.push("--allowedTools", "");

      log("I", runId, "api_req", `model=${model} provider=claude-code`);

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(args, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        log("E", runId, "api_err", `spawn failed: ${error}`);
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      // Write prompt to stdin and close
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (error) {
        log("E", runId, "api_err", `stdin write failed: ${error}`);
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      const streamStart = Date.now();
      log("I", runId, "stream_start");

      let gotText = false;
      let usageYielded = false;
      const mapCtx: MapContext = { runId, textId, reasoningId, parentId };

      try {
        for await (const obj of parseNDJSON(proc.stdout as ReadableStream<Uint8Array>)) {
          const line = obj as Record<string, any>;

          // Stream events contain raw Claude API events
          if (line.type === "stream_event" && line.event) {
            const mapped = mapStreamEvent(line.event, mapCtx);
            if (mapped) {
              if (mapped.type === "text") gotText = true;
              yield mapped;
            }

            // Extract usage from message_delta
            if (line.event.type === "message_delta" && line.event.usage) {
              const u = line.event.usage;
              if (u.output_tokens) {
                yield tag({
                  type: "usage" as const,
                  runId,
                  inputTokens: u.input_tokens ?? 0,
                  outputTokens: u.output_tokens ?? 0,
                });
                usageYielded = true;
              }
            }
          }

          // ResultMessage — fallback usage source
          if (line.type === "result" && !usageYielded) {
            const u = line.usage;
            if (u) {
              yield tag({
                type: "usage" as const,
                runId,
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
              });
              usageYielded = true;
            }
          }
        }
      } catch (error) {
        log("E", runId, "api_err", `stream error: ${error}`);
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      log("I", runId, "stream_end", `dur=${Date.now() - streamStart}ms`);

      // Wait for process to finish
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        let stderr = "";
        try {
          stderr = await new Response(proc.stderr as ReadableStream).text();
        } catch {}
        yield tag({
          type: "error" as const,
          runId,
          error: new Error(`claude process exited with code ${exitCode}: ${stderr}`.trim()),
        });
        return;
      }

      if (!gotText) {
        yield tag({
          type: "error" as const,
          runId,
          error: new Error("No response from Claude Code CLI"),
        });
      }
    },

    async supportedModels(): Promise<string[]> {
      return ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];
    },
  };
}

export { createGeneratorHarness };
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: PASS (the three unit tests — interface, supportedModels, no-model error)

**Step 5: Commit**

```bash
git add packages/ai/harness/providers/claude-code.ts packages/ai/harness/providers/__tests__/claude-code.test.ts
git commit -m "feat(claude-code): implement createGeneratorHarness with Bun.spawn"
```

---

### Task 5: Integration test

**Files:**
- Modify: `packages/ai/harness/providers/__tests__/claude-code.test.ts`

Requires `CLAUDE_CODE_OAUTH_TOKEN` env var to be set.

**Step 1: Write the integration tests**

Append to test file:

```typescript
describe("integration", () => {
  beforeAll(() => {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error("CLAUDE_CODE_OAUTH_TOKEN required for integration tests");
    }
  });

  test(
    "invoke yields text events from claude -p",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];
      for await (const e of harness.invoke({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: 'Say only the word "test"' }],
      })) {
        events.push(e);
      }

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThan(0);

      const fullText = textEvents.map((e) => (e as any).content).join("");
      expect(fullText.toLowerCase()).toContain("test");
    },
    { timeout: 60000 },
  );

  test(
    "invoke handles multi-turn conversation",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];
      for await (const e of harness.invoke({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "You are a helpful assistant. Be very brief." },
          { role: "user", content: "Remember the number 42." },
          { role: "assistant", content: "I will remember the number 42." },
          { role: "user", content: "What number did I ask you to remember?" },
        ],
      })) {
        events.push(e);
      }

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThan(0);

      const fullText = textEvents.map((e) => (e as any).content).join("");
      expect(fullText).toContain("42");
    },
    { timeout: 60000 },
  );

  test(
    "invoke yields usage event",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];
      for await (const e of harness.invoke({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: 'Say only "hi"' }],
      })) {
        events.push(e);
      }

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents.length).toBeGreaterThanOrEqual(1);

      const usage = usageEvents[0]!;
      expect(typeof (usage as any).inputTokens).toBe("number");
      expect(typeof (usage as any).outputTokens).toBe("number");
    },
    { timeout: 60000 },
  );

  test(
    "parentId tagging works",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];
      for await (const e of harness.invoke({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: 'Say only "hi"' }],
        env: { parentId: "test-parent-123" },
      })) {
        events.push(e);
      }

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThan(0);
      expect((textEvents[0] as any).parentId).toBe("test-parent-123");
    },
    { timeout: 60000 },
  );
});
```

**Step 2: Run integration tests**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: PASS (if `CLAUDE_CODE_OAUTH_TOKEN` is set; integration tests skip otherwise)

**Step 3: Commit**

```bash
git add packages/ai/harness/providers/__tests__/claude-code.test.ts
git commit -m "test(claude-code): add integration tests for claude -p provider"
```

---

### Task 6: Format and final verification

**Step 1: Run formatter**

Run: `bun run format`

**Step 2: Run all unit tests to ensure no regressions**

Run: `bun test packages/ai/harness/providers/__tests__/claude-code.test.ts`
Expected: PASS

**Step 3: Run the existing RLM unit tests to confirm compatibility**

Run: `bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: PASS (these use the deterministic harness, unchanged)

**Step 4: Commit if formatter changed anything**

```bash
git add -A && git commit -m "chore: format claude-code provider"
```
