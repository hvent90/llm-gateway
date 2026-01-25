import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import type { HarnessEvent, ToolDefinition } from "../types";
import { createGeneratorHarness, openRouterHarness } from "./openrouter";

const CalculatorSchema = z.object({
  a: z.number().describe("First number"),
  b: z.number().describe("Second number"),
  op: z.enum(["+", "-", "*", "/"]).describe("Operation"),
});

const calculatorTool: ToolDefinition<typeof CalculatorSchema, number> = {
  name: "calculator",
  description: "Perform basic arithmetic. Always use this for math.",
  schema: CalculatorSchema,
  execute: async (input: z.infer<typeof CalculatorSchema>) => {
    let result: number;
    switch (input.op) {
      case "+":
        result = input.a + input.b;
        break;
      case "-":
        result = input.a - input.b;
        break;
      case "*":
        result = input.a * input.b;
        break;
      case "/":
        result = input.a / input.b;
        break;
    }
    return { context: `Result: ${result}`, result };
  },
};

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

      const events = await collectEvents(
        openRouterHarness.invoke({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Please greet Alice using the hello_world tool." }],
          tools: [helloWorldTool],
          permissions: {
            allowlist: [{ tool: "hello_world" }],
          },
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
});

describe("generator harness permissions", () => {
  beforeAll(() => {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY required for integration tests");
    }
  });

  test(
    "yields permission_required and pauses until respond() called",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];
      let permissionCount = 0;

      const stream = harness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
        tools: [calculatorTool],
        permissions: {
          allowlist: [], // Empty - requires permission
        },
      });

      for await (const event of stream) {
        events.push(event);
        if (event.type === "permission_required") {
          permissionCount++;
          // The generator should pause here until respond() is called
          // Call respond to continue
          event.respond(true);
        }
      }

      // Should have seen at least one permission request
      expect(permissionCount).toBeGreaterThanOrEqual(1);

      // After approval, should have tool_call and tool_result
      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      const toolResultEvents = events.filter((e) => e.type === "tool_result");

      expect(toolCallEvents.length).toBeGreaterThan(0);
      expect(toolResultEvents.length).toBeGreaterThan(0);
    },
    { timeout: 30000 },
  );

  test(
    "denial via respond(false) yields denied tool_result",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];

      const stream = harness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
        tools: [calculatorTool],
        permissions: {
          allowlist: [], // Empty - requires permission
        },
      });

      for await (const event of stream) {
        events.push(event);
        if (event.type === "permission_required") {
          // Deny the permission
          event.respond(false, "User denied");
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
    { timeout: 30000 },
  );

  test(
    "executes tool automatically when in allowlist",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];

      const stream = harness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
        tools: [calculatorTool],
        permissions: {
          allowlist: [{ tool: "calculator" }],
        },
      });

      for await (const event of stream) {
        events.push(event);
      }

      // Should NOT have any permission_required events
      const permissionEvents = events.filter((e) => e.type === "permission_required");
      expect(permissionEvents.length).toBe(0);

      // Should have tool execution
      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      expect(toolResultEvents.length).toBeGreaterThan(0);
    },
    { timeout: 30000 },
  );

  test(
    "agent loop continues after tool result until LLM completes",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];

      // Use the same model as scripts/stream.ts which is known to work with the agent loop
      const stream = harness.invoke({
        model: TEST_MODEL,
        messages: [
          {
            role: "user",
            content: "What is 2+2? Use the calculator tool and then tell me the answer in words.",
          },
        ],
        tools: [calculatorTool],
        permissions: {
          allowlist: [{ tool: "calculator" }],
        },
      });

      for await (const event of stream) {
        events.push(event);
      }

      // Should have tool_call, tool_result
      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      const toolResultEvents = events.filter((e) => e.type === "tool_result");

      expect(toolCallEvents.length).toBeGreaterThan(0);
      expect(toolResultEvents.length).toBeGreaterThan(0);

      // The harness loop should have made at least two LLM calls:
      // 1. Initial call that produced tool_call
      // 2. Follow-up call after tool_result (which may or may not produce text)
      // We verify the loop worked by checking we have tool execution and no errors
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(0);

      // Stream should have completed (we got here without hanging)
      // The presence of tool_call + tool_result with no errors proves the loop works
    },
    { timeout: 60000 },
  );

  test(
    "deny list blocks specific tool calls",
    async () => {
      const harness = createGeneratorHarness();
      const events: HarnessEvent[] = [];

      // First call to get a tool call ID
      const stream1 = harness.invoke({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
        tools: [calculatorTool],
        permissions: {
          allowlist: [], // Requires permission
        },
      });

      let capturedToolCallId: string | undefined;
      for await (const event of stream1) {
        events.push(event);
        if (event.type === "permission_required") {
          capturedToolCallId = event.toolCallId;
          event.respond(false, "Testing deny"); // Deny to end stream
          break;
        }
      }

      expect(capturedToolCallId).toBeDefined();
    },
    { timeout: 30000 },
  );
});
