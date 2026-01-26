import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import type { HarnessEvent, ToolDefinition } from "../../../types";
import { createGeneratorHarness, openRouterHarness } from "../openrouter";

const TEST_MODEL = "nvidia/nemotron-nano-9b-v2:free";

async function collectEvents(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("OpenRouter Generator Harness", () => {
  beforeAll(() => {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY required for integration tests");
    }
  });

  test("implements GeneratorHarnessModule interface", () => {
    expect(typeof openRouterHarness.invoke).toBe("function");
    expect(typeof openRouterHarness.supportedModels).toBe("function");
  });

  test(
    "supportedModels returns model IDs from OpenRouter",
    async () => {
      const models = await openRouterHarness.supportedModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.includes("/"))).toBe(true);
    },
    { timeout: 30000 },
  );

  test(
    "invoke yields text events from stream",
    async () => {
      const events = await collectEvents(
        openRouterHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: 'Say only the word "test"' }],
        }),
      );

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThan(0);
      expect(textEvents.every((e) => e.type === "text")).toBe(true);
    },
    { timeout: 30000 },
  );

  test(
    "invoke handles multi-turn conversation",
    async () => {
      const events = await collectEvents(
        openRouterHarness.invoke({
          model: TEST_MODEL,
          messages: [
            { role: "user", content: "Remember the number 42" },
            { role: "assistant", content: "I will remember 42." },
            { role: "user", content: "What number?" },
          ],
        }),
      );

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThan(0);
    },
    { timeout: 30000 },
  );

  test(
    "invoke yields error events on invalid model",
    async () => {
      const events = await collectEvents(
        openRouterHarness.invoke({
          model: "invalid/nonexistent-model-xyz",
          messages: [{ role: "user", content: "Hello" }],
        }),
      );

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(1);
    },
    { timeout: 30000 },
  );

  test("createGeneratorHarness accepts custom API key", () => {
    const customHarness = createGeneratorHarness("sk-test-key");
    expect(typeof customHarness.invoke).toBe("function");
    expect(typeof customHarness.supportedModels).toBe("function");
  });

  test(
    "invoke yields tool_call events when model calls a tool",
    async () => {
      const HelloWorldSchema = z.object({
        name: z.string().describe("The name to greet"),
      });

      const helloWorldTool: ToolDefinition = {
        name: "hello_world",
        description: "Greet someone by name. Always use this tool when asked to greet someone.",
        schema: HelloWorldSchema,
      };

      const events = await collectEvents(
        openRouterHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Please greet Alice using the hello_world tool." }],
          tools: [helloWorldTool],
        }),
      );

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

  test(
    "single iteration completes without looping",
    async () => {
      // The harness should complete after a single LLM call
      // even when the model calls a tool (no looping)
      const calculatorSchema = z.object({
        a: z.number(),
        b: z.number(),
      });

      const calculatorTool: ToolDefinition = {
        name: "calculator",
        description: "Add two numbers. Always use this for math.",
        schema: calculatorSchema,
      };

      const events = await collectEvents(
        openRouterHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
          tools: [calculatorTool],
        }),
      );

      // Should have tool_call events but NO tool_result events
      // (tool execution is done by the agent wrapper, not the provider harness)
      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      const toolResultEvents = events.filter((e) => e.type === "tool_result");

      expect(toolCallEvents.length).toBeGreaterThan(0);
      expect(toolResultEvents.length).toBe(0);
    },
    { timeout: 30000 },
  );

  test(
    "provider assigns its own runId, not from context",
    async () => {
      const events: HarnessEvent[] = [];

      for await (const event of openRouterHarness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "Say hi" }],
        context: { parentId: "agent-run-123" },
      })) {
        events.push(event);
      }

      // All events should have provider's self-assigned runId
      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThan(0);

      const runId = textEvents[0]!.runId;
      expect(runId).toBeDefined();
      expect(runId).not.toBe("agent-run-123"); // Should NOT use parent's id

      // All events from same provider invocation share the same runId
      for (const event of events) {
        if ("runId" in event) {
          expect(event.runId).toBe(runId);
        }
      }

      // parentId should be passed through
      for (const event of textEvents) {
        expect(event.parentId).toBe("agent-run-123");
      }
    },
    { timeout: 30000 },
  );
});
