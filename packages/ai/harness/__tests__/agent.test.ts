import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import type { GeneratorHarnessModule, HarnessEvent, ToolDefinition } from "../../types.ts";
import { openRouterHarness, createGeneratorHarness } from "../providers/openrouter.ts";
import { createAgentHarness } from "../agent.ts";

const TEST_MODEL = "nvidia/nemotron-nano-9b-v2:free";

async function collectEvents(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("Agent Harness", () => {
  beforeAll(() => {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY required for integration tests");
    }
  });

  test("implements GeneratorHarnessModule interface", () => {
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

      const events = await collectEvents(
        agentHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Please greet Bob using the greet tool." }],
          tools: [greetTool],
          permissions: {
            allowlist: [{ tool: "greet" }],
          },
        }),
      );

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

      const events = await collectEvents(
        agentHarness.invoke({
          model: TEST_MODEL,
          messages: [
            {
              role: "user",
              content:
                "Use the add tool twice: first add 2 and 3, then add 10 and 20. Report both results.",
            },
          ],
          tools: [addTool],
          permissions: {
            allowlist: [{ tool: "add" }],
          },
        }),
      );

      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      // Should have at least 2 tool results (might be in same or different iterations)
      expect(toolResultEvents.length).toBeGreaterThanOrEqual(2);
    },
    { timeout: 90000 },
  );

  test(
    "yields error when tool has no executor",
    async () => {
      const noExecSchema = z.object({ value: z.string() });

      const noExecTool: ToolDefinition<typeof noExecSchema> = {
        name: "no_exec",
        description: "A tool without an executor. Always use this tool.",
        schema: noExecSchema,
        // No execute function!
      };

      const agentHarness = createAgentHarness({ harness: openRouterHarness });

      const events = await collectEvents(
        agentHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Use the no_exec tool with value 'test'." }],
          tools: [noExecTool],
          permissions: {
            allowlist: [{ tool: "no_exec" }],
          },
        }),
      );

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0]!.error.message).toContain("No executor for tool");
    },
    { timeout: 30000 },
  );

  test(
    "respects maxIterations limit",
    async () => {
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

      await collectEvents(
        agentHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Keep calling the loop tool repeatedly." }],
          tools: [loopTool],
          permissions: {
            allowlist: [{ tool: "loop" }],
          },
        }),
      );

      // Should stop after maxIterations even if model wants more tool calls
      expect(executionCount).toBeLessThanOrEqual(2);
    },
    { timeout: 60000 },
  );

  test(
    "passes through text events without tools",
    async () => {
      const agentHarness = createAgentHarness({ harness: openRouterHarness });

      const events = await collectEvents(
        agentHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Say hello without using any tools." }],
        }),
      );

      const textEvents = events.filter((e) => e.type === "text");
      const toolCallEvents = events.filter((e) => e.type === "tool_call");

      expect(textEvents.length).toBeGreaterThan(0);
      expect(toolCallEvents.length).toBe(0);
    },
    { timeout: 30000 },
  );

  test(
    "yields relay permission and pauses until respond() called",
    async () => {
      const calculatorSchema = z.object({ a: z.number(), b: z.number() });

      const calculatorTool: ToolDefinition<typeof calculatorSchema, number> = {
        name: "calculator",
        description: "Add two numbers. Always use this tool for math.",
        schema: calculatorSchema,
        execute: async ({ a, b }) => ({
          context: `${a} + ${b} = ${a + b}`,
          result: a + b,
        }),
      };

      const agentHarness = createAgentHarness({
        harness: createGeneratorHarness(),
        maxIterations: 5,
      });

      const events: HarnessEvent[] = [];
      let relayCount = 0;

      const stream = agentHarness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
        tools: [calculatorTool],
        permissions: {
          allowlist: [], // Nothing allowed - will trigger permission_required
        },
      });

      for await (const event of stream) {
        events.push(event);
        if (event.type === "relay") {
          relayCount++;
          // Approve the permission to continue
          event.respond({ approved: true });
        }
      }

      // Should have seen at least one permission request
      expect(relayCount).toBeGreaterThanOrEqual(1);

      // After approval, should have tool_call and tool_result
      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      const toolResultEvents = events.filter((e) => e.type === "tool_result");

      expect(toolCallEvents.length).toBeGreaterThan(0);
      expect(toolResultEvents.length).toBeGreaterThan(0);

      // Should complete without error
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(0);
    },
    { timeout: 60000 },
  );

  test(
    "denial via relay respond yields denied tool_result",
    async () => {
      const calculatorSchema = z.object({ a: z.number(), b: z.number() });

      const calculatorTool: ToolDefinition<typeof calculatorSchema, number> = {
        name: "calculator",
        description: "Add two numbers. Always use this tool for math.",
        schema: calculatorSchema,
        execute: async ({ a, b }) => ({
          context: `${a} + ${b} = ${a + b}`,
          result: a + b,
        }),
      };

      const agentHarness = createAgentHarness({
        harness: createGeneratorHarness(),
        maxIterations: 5,
      });

      const events: HarnessEvent[] = [];

      const stream = agentHarness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
        tools: [calculatorTool],
        permissions: {
          allowlist: [], // Nothing allowed - will trigger permission_required
        },
      });

      for await (const event of stream) {
        events.push(event);
        if (event.type === "relay") {
          // Deny the permission
          event.respond({ approved: false, reason: "User denied" });
        }
      }

      // Should have tool_result with denied status
      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      expect(toolResultEvents.length).toBeGreaterThan(0);

      const deniedResult = toolResultEvents.find(
        (e) => e.type === "tool_result" && (e.output as { status?: string })?.status === "denied",
      );
      expect(deniedResult).toBeDefined();
    },
    { timeout: 60000 },
  );

  test(
    "executes tool automatically when in allowlist",
    async () => {
      const calculatorSchema = z.object({ a: z.number(), b: z.number() });

      const calculatorTool: ToolDefinition<typeof calculatorSchema, number> = {
        name: "calculator",
        description: "Add two numbers. Always use this tool for math.",
        schema: calculatorSchema,
        execute: async ({ a, b }) => ({
          context: `${a} + ${b} = ${a + b}`,
          result: a + b,
        }),
      };

      const agentHarness = createAgentHarness({
        harness: createGeneratorHarness(),
        maxIterations: 5,
      });

      const events = await collectEvents(
        agentHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
          tools: [calculatorTool],
          permissions: {
            allowlist: [{ tool: "calculator" }],
          },
        }),
      );

      // Should NOT have any relay events
      const relayEvents = events.filter((e) => e.type === "relay");
      expect(relayEvents.length).toBe(0);

      // Should have tool execution
      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      expect(toolResultEvents.length).toBeGreaterThan(0);
    },
    { timeout: 60000 },
  );

  test("returns final assistant text as generator return value", async () => {
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "text", runId: "r1", id: "t1", content: "Hello " };
        yield { type: "text", runId: "r1", id: "t2", content: "world" };
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness });

    const stream = agentHarness.invoke({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    });

    const iterator = stream[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done) {
      next = await iterator.next();
    }

    expect(next.value).toBe("Hello world");
  });

  test("agent assigns its own runId, passes it as parentId to provider", async () => {
    const capturedContexts: Array<{ parentId?: string }> = [];

    // Create a mock harness that captures the context it receives
    const mockHarness: GeneratorHarnessModule = {
      async *invoke(params) {
        capturedContexts.push({ parentId: params.context?.parentId });
        yield { type: "text", runId: "provider-run", id: "t1", content: "Hello" };
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness });

    const events = await collectEvents(
      agentHarness.invoke({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    // Agent should have passed its own runId as parentId to provider
    expect(capturedContexts.length).toBe(1);
    expect(capturedContexts[0].parentId).toBeDefined();
    expect(typeof capturedContexts[0].parentId).toBe("string");
    expect(capturedContexts[0].parentId!.length).toBeGreaterThan(0);
  });
});

test("passes spawn from context through to tool execute, wrapping with tool call ID", async () => {
  let receivedSpawn: ((task: string) => Promise<string>) | undefined;
  const spawnCalls: Array<{ task: string; parentId: string }> = [];

  const toolSchema = z.object({ value: z.string() });
  const captureTool: ToolDefinition<typeof toolSchema, string> = {
    name: "capture",
    description: "Captures context. Always use this tool.",
    schema: toolSchema,
    execute: async (_input, ctx) => {
      receivedSpawn = ctx.spawn;
      if (ctx.spawn) await ctx.spawn("sub-task");
      return { context: "captured", result: "ok" };
    },
  };

  // Provider that emits a tool call
  const mockHarness: GeneratorHarnessModule = {
    async *invoke(params) {
      const hasToolResult = params.messages.some((m) => m.role === "tool");
      if (hasToolResult) {
        yield { type: "text", runId: "r1", id: "t2", content: "Done" };
      } else {
        yield {
          type: "tool_call",
          runId: "r1",
          id: "tc-1",
          name: "capture",
          input: { value: "test" },
        };
      }
    },
    async supportedModels() {
      return ["test-model"];
    },
  };

  const spawnFn = async (task: string, parentId: string) => {
    spawnCalls.push({ task, parentId });
    return task;
  };

  const agentHarness = createAgentHarness({ harness: mockHarness });
  const events: HarnessEvent[] = [];
  for await (const event of agentHarness.invoke({
    model: "test-model",
    messages: [{ role: "user", content: "Use capture tool" }],
    tools: [captureTool],
    permissions: { allowlist: [{ tool: "capture" }] },
    context: { spawn: spawnFn },
  })) {
    events.push(event);
  }

  // Tool should have received a spawn function (wrapped)
  expect(receivedSpawn).toBeDefined();
  expect(typeof receivedSpawn).toBe("function");

  // The underlying spawn should have been called with the task and the tool call ID
  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0].task).toBe("sub-task");
  expect(spawnCalls[0].parentId).toBe("tc-1");
});

test("dispatches multiple tool calls concurrently", async () => {
  const callOrder: string[] = [];
  const slowSchema = z.object({ id: z.string() });

  const slowTool: ToolDefinition<typeof slowSchema, string> = {
    name: "slow",
    description: "A slow tool",
    schema: slowSchema,
    execute: async ({ id }) => {
      callOrder.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push(`end-${id}`);
      return { context: `done-${id}`, result: id };
    },
  };

  // Provider that emits two tool calls in one response
  const mockHarness: GeneratorHarnessModule = {
    async *invoke(params) {
      const hasToolResult = params.messages.some((m) => m.role === "tool");
      if (hasToolResult) {
        yield { type: "text", runId: "r1", id: "t1", content: "All done" };
      } else {
        yield { type: "tool_call", runId: "r1", id: "tc-1", name: "slow", input: { id: "a" } };
        yield { type: "tool_call", runId: "r1", id: "tc-2", name: "slow", input: { id: "b" } };
      }
    },
    async supportedModels() {
      return ["test-model"];
    },
  };

  const agentHarness = createAgentHarness({ harness: mockHarness });

  for await (const _ of agentHarness.invoke({
    model: "test-model",
    messages: [{ role: "user", content: "Run both" }],
    tools: [slowTool],
    permissions: { allowlist: [{ tool: "slow" }] },
  })) {
    // drain
  }

  // If concurrent: start-a, start-b, end-a, end-b (or end-b, end-a)
  // If sequential: start-a, end-a, start-b, end-b
  // Concurrent means both starts happen before any end
  expect(callOrder[0]).toBe("start-a");
  expect(callOrder[1]).toBe("start-b");
});
