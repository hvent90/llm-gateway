import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import type { HarnessEvent, ToolDefinition } from "../../../packages/ai/types.ts";
import { createHarness, openRouterHarness } from "../../../packages/ai/harness/openrouter.ts";

const TEST_MODEL = "nvidia/nemotron-nano-9b-v2:free";

function collectEvents() {
  const events: HarnessEvent[] = [];
  return {
    emit: (e: HarnessEvent) => events.push(e),
    events,
  };
}

describe("OpenRouter Harness", () => {
  beforeAll(() => {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY required for integration tests");
    }
  });

  test("implements HarnessModule interface", () => {
    expect(typeof openRouterHarness.invoke).toBe("function");
    expect(typeof openRouterHarness.supportedModels).toBe("function");
  });

  test("supportedModels returns model IDs from OpenRouter", async () => {
    const models = await openRouterHarness.supportedModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.includes("/"))).toBe(true);
  });

  test("invoke yields text events from stream", async () => {
    const { emit, events } = collectEvents();
    await openRouterHarness.invoke({
      model: TEST_MODEL,
      messages: [{ role: "user", content: 'Say only the word "test"' }],
      emit,
    });

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents.every((e) => e.type === "text")).toBe(true);
  });

  test("invoke handles multi-turn conversation", async () => {
    const { emit, events } = collectEvents();
    await openRouterHarness.invoke({
      model: TEST_MODEL,
      messages: [
        { role: "user", content: "Remember the number 42" },
        { role: "assistant", content: "I will remember 42." },
        { role: "user", content: "What number?" },
      ],
      emit,
    });

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
  });

  test("invoke yields error events on invalid model", async () => {
    const { emit, events } = collectEvents();
    await openRouterHarness.invoke({
      model: "invalid/nonexistent-model-xyz",
      messages: [{ role: "user", content: "Hello" }],
      emit,
    });

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(1);
  });

  test("createHarness accepts custom API key", () => {
    const customHarness = createHarness("sk-test-key");
    expect(typeof customHarness.invoke).toBe("function");
    expect(typeof customHarness.supportedModels).toBe("function");
  });

  test(
    "invoke yields reasoning events for reasoning model",
    async () => {
      const { emit, events } = collectEvents();
      await openRouterHarness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "What is 2+2?" }],
        emit,
      });

      const reasoningEvents = events.filter((e) => e.type === "reasoning");
      const textEvents = events.filter((e) => e.type === "text");

      // Model should produce reasoning tokens
      expect(reasoningEvents.length).toBeGreaterThan(0);
      expect(textEvents.length).toBeGreaterThan(0);
    },
    { timeout: 30000 },
  );

  test(
    "invoke yields tool_call events when using hello-world tool",
    async () => {
      const HelloWorldSchema = z.object({
        name: z.string().describe("The name to greet"),
      });

      const helloWorldTool: ToolDefinition = {
        name: "hello_world",
        description: "Greet someone by name. Always use this tool when asked to greet someone.",
        schema: HelloWorldSchema,
      };

      const { emit, events } = collectEvents();
      await openRouterHarness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "Please greet Alice using the hello_world tool." }],
        tools: [helloWorldTool],
        emit,
      });

      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      expect(toolCallEvents.length).toBeGreaterThan(0);

      const toolCall = toolCallEvents[0]!;
      expect(toolCall.type).toBe("tool_call");
      expect(toolCall.name).toBe("hello_world");
      expect(typeof toolCall.id).toBe("string");
      expect(toolCall.input).toHaveProperty("name");
    },
    { timeout: 30000 },
  );
});
