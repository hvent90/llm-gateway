import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import type { HarnessEvent, ToolDefinition } from "../../../packages/ai/types.ts";
import { openRouterHarness } from "../../../packages/ai/harness/openrouter.ts";
import { createAgentHarness } from "../../../packages/ai/harness/agent.ts";

const TEST_MODEL = "nvidia/nemotron-nano-9b-v2:free";

function collectEvents() {
  const events: HarnessEvent[] = [];
  return {
    emit: (e: HarnessEvent) => events.push(e),
    events,
  };
}

describe("Agent Harness", () => {
  beforeAll(() => {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY required for integration tests");
    }
  });

  test("implements HarnessModule interface", () => {
    const agentHarness = createAgentHarness({ harness: openRouterHarness });
    expect(typeof agentHarness.invoke).toBe("function");
    expect(typeof agentHarness.supportedModels).toBe("function");
  });

  test("supportedModels delegates to inner harness", async () => {
    const agentHarness = createAgentHarness({ harness: openRouterHarness });
    const models = await agentHarness.supportedModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  test(
    "executes tool and returns result to model",
    async () => {
      const greetSchema = z.object({ name: z.string() });

      const greetTool: ToolDefinition<typeof greetSchema, { greeted: string }> = {
        name: "greet",
        description: "Greet someone by name. Always use this tool when asked to greet.",
        schema: greetSchema,
        execute: async ({ name }) => ({
          context: `Greeted ${name} successfully.`,
          result: { greeted: name },
        }),
      };

      const agentHarness = createAgentHarness({ harness: openRouterHarness });

      const { emit, events } = collectEvents();
      await agentHarness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "Please greet Bob using the greet tool." }],
        tools: [greetTool],
        emit,
      });

      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      const textEvents = events.filter((e) => e.type === "text");

      expect(toolCallEvents.length).toBeGreaterThan(0);
      expect(toolResultEvents.length).toBeGreaterThan(0);

      const toolResult = toolResultEvents[0]!;
      expect(toolResult.type).toBe("tool_result");
      // tool_result.output now contains { context, result } from tool execution
      expect((toolResult.output as { result: unknown }).result).toEqual({ greeted: "Bob" });

      // Model should respond after receiving tool result
      expect(textEvents.length).toBeGreaterThan(0);
    },
    { timeout: 60000 },
  );

  test(
    "handles multiple tool calls in sequence",
    async () => {
      const addSchema = z.object({ a: z.number(), b: z.number() });

      const addTool: ToolDefinition<typeof addSchema, number> = {
        name: "add",
        description: "Add two numbers together. Use this for any addition.",
        schema: addSchema,
        execute: async ({ a, b }) => ({
          context: `${a} + ${b} = ${a + b}`,
          result: a + b,
        }),
      };

      const agentHarness = createAgentHarness({ harness: openRouterHarness });

      const { emit, events } = collectEvents();
      await agentHarness.invoke({
        model: TEST_MODEL,
        messages: [
          {
            role: "user",
            content:
              "Use the add tool twice: first add 2 and 3, then add 10 and 20. Report both results.",
          },
        ],
        tools: [addTool],
        emit,
      });

      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      // Should have at least 2 tool results (might be in same or different iterations)
      expect(toolResultEvents.length).toBeGreaterThanOrEqual(2);
    },
    { timeout: 90000 },
  );

  test("yields error when tool has no executor", async () => {
    const noExecSchema = z.object({ value: z.string() });

    const noExecTool: ToolDefinition<typeof noExecSchema> = {
      name: "no_exec",
      description: "A tool without an executor. Always use this tool.",
      schema: noExecSchema,
      // No execute function!
    };

    const agentHarness = createAgentHarness({ harness: openRouterHarness });

    const { emit, events } = collectEvents();
    await agentHarness.invoke({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "Use the no_exec tool with value 'test'." }],
      tools: [noExecTool],
      emit,
    });

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0]!.error.message).toContain("No executor for tool");
  }, { timeout: 30000 });

  test("respects maxIterations limit", async () => {
    const loopSchema = z.object({});
    let executionCount = 0;

    const loopTool: ToolDefinition<typeof loopSchema, number> = {
      name: "loop",
      description: "A tool that always asks to be called again. Always call this tool.",
      schema: loopSchema,
      execute: async () => {
        executionCount++;
        return {
          context: "Please call the loop tool again.",
          result: executionCount,
        };
      },
    };

    const agentHarness = createAgentHarness({
      harness: openRouterHarness,
      maxIterations: 2,
    });

    const { emit } = collectEvents();
    await agentHarness.invoke({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "Keep calling the loop tool repeatedly." }],
      tools: [loopTool],
      emit,
    });

    // Should stop after maxIterations even if model wants more tool calls
    expect(executionCount).toBeLessThanOrEqual(2);
  }, { timeout: 60000 });

  test(
    "passes through text events without tools",
    async () => {
      const agentHarness = createAgentHarness({ harness: openRouterHarness });

      const { emit, events } = collectEvents();
      await agentHarness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "Say hello without using any tools." }],
        emit,
      });

      const textEvents = events.filter((e) => e.type === "text");
      const toolCallEvents = events.filter((e) => e.type === "tool_call");

      expect(textEvents.length).toBeGreaterThan(0);
      expect(toolCallEvents.length).toBe(0);
    },
    { timeout: 30000 },
  );
});
