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
        capturedContexts.push({ parentId: params.env?.parentId });
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
    expect(capturedContexts[0]!.parentId).toBeDefined();
    expect(typeof capturedContexts[0]!.parentId).toBe("string");
    expect(capturedContexts[0]!.parentId!.length).toBeGreaterThan(0);
  });
});

describe("harness_start / harness_end lifecycle events", () => {
  test("emits harness_start as first event and harness_end as last event", async () => {
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
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

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]!.type).toBe("harness_start");
    expect(events[events.length - 1]!.type).toBe("harness_end");
  });

  test("harness_start and harness_end carry the agent's runId", async () => {
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
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

    const start = events[0]!;
    const end = events[events.length - 1]!;

    expect(start.type).toBe("harness_start");
    expect(end.type).toBe("harness_end");
    expect(start.runId).toBeDefined();
    expect(start.runId).toBe(end.runId);

    // Text events carry the provider's own runId (not the agent's)
    const textEvent = events.find((e) => e.type === "text")!;
    expect(textEvent.runId).not.toBe(start.runId);
    expect(textEvent.runId).toBe("r1");
  });

  test("harness_start and harness_end carry parentId when context.parentId is set", async () => {
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
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
        env: { parentId: "parent-xyz" },
      }),
    );

    const start = events[0]!;
    const end = events[events.length - 1]!;

    expect(start.type).toBe("harness_start");
    expect((start as { parentId?: string }).parentId).toBe("parent-xyz");
    expect(end.type).toBe("harness_end");
    expect((end as { parentId?: string }).parentId).toBe("parent-xyz");
  });

  test("harness_start and harness_end have no parentId when context.parentId is not set", async () => {
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
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

    const start = events[0]!;
    const end = events[events.length - 1]!;

    expect(start.type).toBe("harness_start");
    expect("parentId" in start).toBe(false);
    expect(end.type).toBe("harness_end");
    expect("parentId" in end).toBe(false);
  });

  test("emits harness_end before return on provider error", async () => {
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "text", runId: "r1", id: "t1", content: "before error" };
        yield { type: "error", runId: "r1", error: new Error("provider failed") };
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

    expect(events[0]!.type).toBe("harness_start");
    expect(events[events.length - 1]!.type).toBe("harness_end");

    // Error should be second-to-last (before harness_end)
    const errorIdx = events.findIndex((e) => e.type === "error");
    expect(errorIdx).toBeGreaterThan(0);
    expect(errorIdx).toBe(events.length - 2);
  });

  test("emits harness_end before return on no-executor error", async () => {
    const noExecSchema = z.object({ value: z.string() });
    const noExecTool: ToolDefinition<typeof noExecSchema> = {
      name: "no_exec",
      description: "A tool without an executor.",
      schema: noExecSchema,
      // No execute function
    };

    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield {
          type: "tool_call",
          runId: "r1",
          id: "tc-1",
          name: "no_exec",
          input: { value: "x" },
        };
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness });
    const events = await collectEvents(
      agentHarness.invoke({
        model: "test-model",
        messages: [{ role: "user", content: "Use no_exec" }],
        tools: [noExecTool],
        permissions: { allowlist: [{ tool: "no_exec" }] },
      }),
    );

    expect(events[0]!.type).toBe("harness_start");
    expect(events[events.length - 1]!.type).toBe("harness_end");

    // Should have an error event about no executor
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(1);
  });

  test("emits harness_end on max iterations reached", async () => {
    const loopSchema = z.object({});
    const loopTool: ToolDefinition<typeof loopSchema, string> = {
      name: "loop",
      description: "Always loops.",
      schema: loopSchema,
      execute: async () => ({
        context: "call again",
        result: "looped",
      }),
    };

    // Provider always emits a tool_call
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "tool_call", runId: "r1", id: `tc-${Date.now()}`, name: "loop", input: {} };
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness, maxIterations: 2 });
    const events = await collectEvents(
      agentHarness.invoke({
        model: "test-model",
        messages: [{ role: "user", content: "Loop" }],
        tools: [loopTool],
        permissions: { allowlist: [{ tool: "loop" }] },
      }),
    );

    expect(events[0]!.type).toBe("harness_start");
    expect(events[events.length - 1]!.type).toBe("harness_end");
  });
});

describe("graceful exit on maxIterations exhaustion", () => {
  test("makes a final summarizing call with no tools when maxIterations exhausted with pending tool calls", async () => {
    const loopSchema = z.object({});
    let invokeCount = 0;
    const capturedParams: Array<{ tools?: unknown[]; messages: unknown[] }> = [];

    const loopTool: ToolDefinition<typeof loopSchema, string> = {
      name: "loop",
      description: "Always loops.",
      schema: loopSchema,
      execute: async () => ({
        context: "call again",
        result: "looped",
      }),
    };

    // Mock harness that tracks invocations:
    // - Normal iterations: emits a tool_call
    // - Summarizing iteration (no tools provided): emits text summary
    const mockHarness: GeneratorHarnessModule = {
      async *invoke(params) {
        invokeCount++;
        capturedParams.push({ tools: params.tools as unknown[], messages: [...params.messages] });

        const hasTools = params.tools && params.tools.length > 0;
        if (!hasTools) {
          // Summarizing call — no tools offered, produce text
          yield {
            type: "text",
            runId: "r1",
            id: `t-${invokeCount}`,
            content: "Here is my summary.",
          };
        } else {
          // Normal call — emit a tool_call
          yield {
            type: "tool_call",
            runId: "r1",
            id: `tc-${invokeCount}`,
            name: "loop",
            input: {},
          };
        }
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness, maxIterations: 2 });

    const stream = agentHarness.invoke({
      model: "test-model",
      messages: [{ role: "user", content: "Loop forever" }],
      tools: [loopTool],
      permissions: { allowlist: [{ tool: "loop" }] },
    });

    const iterator = stream[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done) {
      next = await iterator.next();
    }

    // Return value should be the summary text, not empty
    expect(next.value).toBe("Here is my summary.");

    // Should have made 3 invocations: 2 normal + 1 summarizing
    expect(invokeCount).toBe(3);

    // The last invocation should have received no tools
    const lastParams = capturedParams[capturedParams.length - 1]!;
    expect(lastParams.tools).toEqual([]);

    // The last invocation's messages should contain a system message about summarizing
    const lastMessages = lastParams.messages as Array<{ role: string; content: string }>;
    const systemMsg = lastMessages.find(
      (m) => m.role === "system" && m.content.includes("maximum number of tool call iterations"),
    );
    expect(systemMsg).toBeDefined();
  });

  test("does not make summarizing call when model finishes naturally before maxIterations", async () => {
    let invokeCount = 0;

    // Provider emits text (no tool calls) on first invocation — model finishes naturally
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        invokeCount++;
        yield { type: "text", runId: "r1", id: "t1", content: "Done naturally" };
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness, maxIterations: 5 });

    const stream = agentHarness.invoke({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    });

    const iterator = stream[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done) {
      next = await iterator.next();
    }

    expect(next.value).toBe("Done naturally");
    // Should have made exactly 1 invocation — no extra summarizing call
    expect(invokeCount).toBe(1);
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
    env: { spawn: spawnFn },
  })) {
    events.push(event);
  }

  // Tool should have received a spawn function (wrapped)
  expect(receivedSpawn).toBeDefined();
  expect(typeof receivedSpawn).toBe("function");

  // The underlying spawn should have been called with the task and the namespaced tool call ID
  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0].task).toBe("sub-task");
  // parentId is namespaced: "<runId>/tc-1"
  expect(spawnCalls[0].parentId).toMatch(/^[0-9a-f-]+\/tc-1$/);
});

test("passes through usage events from provider with tag", async () => {
  const mockHarness: GeneratorHarnessModule = {
    async *invoke() {
      yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
      yield { type: "usage", runId: "r1", inputTokens: 10, outputTokens: 5 };
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
      env: { parentId: "parent-abc" },
    }),
  );

  const usageEvents = events.filter((e) => e.type === "usage");
  expect(usageEvents.length).toBe(1);

  const usage = usageEvents[0]!;
  expect(usage.type).toBe("usage");
  expect(usage.inputTokens).toBe(10);
  expect(usage.outputTokens).toBe(5);

  // Provider events pass through untouched — they carry the provider's
  // own runId. Real providers set parentId from env.parentId; this mock doesn't.
  expect(usage.runId).toBe("r1");
});

test("passes through usage events without parentId when no context.parentId", async () => {
  const mockHarness: GeneratorHarnessModule = {
    async *invoke() {
      yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
      yield { type: "usage", runId: "r1", inputTokens: 20, outputTokens: 15 };
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

  const usageEvents = events.filter((e) => e.type === "usage");
  expect(usageEvents.length).toBe(1);
  expect("parentId" in usageEvents[0]!).toBe(false);
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

describe("agent harness default model resolution", () => {
  test("model set at agent creation, not at invoke → works", async () => {
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness, model: "test-model" });
    const events = await collectEvents(
      agentHarness.invoke({
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
  });

  test("model set at both agent creation and invoke → invoke wins", async () => {
    const capturedModels: string[] = [];

    const mockHarness: GeneratorHarnessModule = {
      async *invoke(params) {
        if (params.model) capturedModels.push(params.model);
        yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness, model: "creation-model" });
    await collectEvents(
      agentHarness.invoke({
        model: "invoke-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    // The inner harness should receive "invoke-model", not "creation-model"
    expect(capturedModels[0]).toBe("invoke-model");
  });

  test("model set at neither agent creation nor invoke → throws", async () => {
    const mockHarness: GeneratorHarnessModule = {
      async *invoke() {
        yield { type: "text", runId: "r1", id: "t1", content: "Hello" };
      },
      async supportedModels() {
        return ["test-model"];
      },
    };

    const agentHarness = createAgentHarness({ harness: mockHarness });

    await expect(
      collectEvents(
        agentHarness.invoke({
          messages: [{ role: "user", content: "Hi" }],
        }),
      ),
    ).rejects.toThrow("No model specified");
  });
});
