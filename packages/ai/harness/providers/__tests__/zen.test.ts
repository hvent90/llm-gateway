import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import type { HarnessEvent, ToolDefinition } from "../../../types";
import { createGeneratorHarness, zenHarness } from "../zen";

async function collectEvents(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("Zen Generator Harness", () => {
  test("implements GeneratorHarnessModule interface", () => {
    expect(typeof zenHarness.invoke).toBe("function");
    expect(typeof zenHarness.supportedModels).toBe("function");
  });

  test("createGeneratorHarness accepts custom API key", () => {
    const customHarness = createGeneratorHarness("sk-test-key");
    expect(typeof customHarness.invoke).toBe("function");
    expect(typeof customHarness.supportedModels).toBe("function");
  });

  describe("integration", () => {
    beforeAll(() => {
      if (!process.env.ZEN_API_KEY) {
        throw new Error("ZEN_API_KEY required for integration tests");
      }
    });

    test(
      "supportedModels returns model IDs from Zen",
      async () => {
        const models = await zenHarness.supportedModels();
        expect(Array.isArray(models)).toBe(true);
        expect(models.length).toBeGreaterThan(0);
        expect(models.some((m) => m.includes("pickle"))).toBe(true);
      },
      { timeout: 60000 },
    );

    test(
      "invoke yields text events from stream",
      async () => {
        const events = await collectEvents(
          zenHarness.invoke({
            model: "big-pickle",
            messages: [{ role: "user", content: 'Say only the word "test"' }],
          }),
        );

        const textEvents = events.filter((e) => e.type === "text");
        expect(textEvents.length).toBeGreaterThan(0);
        expect(textEvents.every((e) => e.type === "text")).toBe(true);
      },
      { timeout: 60000 },
    );

    test(
      "invoke handles multi-turn conversation",
      async () => {
        const events = await collectEvents(
          zenHarness.invoke({
            model: "big-pickle",
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
      { timeout: 60000 },
    );

    test(
      "invoke yields error events on invalid model",
      async () => {
        const events = await collectEvents(
          zenHarness.invoke({
            model: "invalid/nonexistent-model-xyz",
            messages: [{ role: "user", content: "Hello" }],
          }),
        );

        const errorEvents = events.filter((e) => e.type === "error");
        expect(errorEvents.length).toBe(1);
      },
      { timeout: 60000 },
    );

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
          zenHarness.invoke({
            model: "big-pickle",
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
      { timeout: 60000 },
    );

    test(
      "single iteration completes without looping",
      async () => {
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
          zenHarness.invoke({
            model: "big-pickle",
            messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
            tools: [calculatorTool],
          }),
        );

        const toolCallEvents = events.filter((e) => e.type === "tool_call");
        const toolResultEvents = events.filter((e) => e.type === "tool_result");

        expect(toolCallEvents.length).toBeGreaterThan(0);
        expect(toolResultEvents.length).toBe(0);
      },
      { timeout: 60000 },
    );

    test(
      "invoke yields usage event after streaming completes",
      async () => {
        const events = await collectEvents(
          zenHarness.invoke({
            model: "big-pickle",
            messages: [{ role: "user", content: 'Say only the word "test"' }],
          }),
        );

        const usageEvents = events.filter((e) => e.type === "usage");
        expect(usageEvents.length).toBe(1);

        const usage = usageEvents[0]!;
        expect(usage.type).toBe("usage");
        expect(typeof usage.inputTokens).toBe("number");
        expect(typeof usage.outputTokens).toBe("number");
        expect(usage.inputTokens).toBeGreaterThan(0);
        expect(usage.outputTokens).toBeGreaterThan(0);

        // Usage event should have the same runId as text events
        const textEvents = events.filter((e) => e.type === "text");
        expect(usage.runId).toBe(textEvents[0]!.runId);
      },
      { timeout: 60000 },
    );

    test(
      "usage event carries parentId when context.parentId is set",
      async () => {
        const events = await collectEvents(
          zenHarness.invoke({
            model: "big-pickle",
            messages: [{ role: "user", content: 'Say only the word "test"' }],
            env: { parentId: "agent-run-456" },
          }),
        );

        const usageEvents = events.filter((e) => e.type === "usage");
        expect(usageEvents.length).toBe(1);
        expect((usageEvents[0]! as { parentId?: string }).parentId).toBe("agent-run-456");
      },
      { timeout: 120000 },
    );

    test(
      "provider assigns its own runId, not from context",
      async () => {
        const events: HarnessEvent[] = [];

        for await (const event of zenHarness.invoke({
          model: "big-pickle",
          messages: [{ role: "user", content: "Say hi" }],
          env: { parentId: "agent-run-123" },
        })) {
          events.push(event);
        }

        const textEvents = events.filter((e) => e.type === "text");
        expect(textEvents.length).toBeGreaterThan(0);

        const runId = textEvents[0]!.runId;
        expect(runId).toBeDefined();
        expect(runId).not.toBe("agent-run-123");

        for (const event of events) {
          if ("runId" in event) {
            expect(event.runId).toBe(runId);
          }
        }

        for (const event of textEvents) {
          expect(event.parentId).toBe("agent-run-123");
        }
      },
      { timeout: 60000 },
    );
  });
});
