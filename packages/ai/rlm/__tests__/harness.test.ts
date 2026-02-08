import { describe, expect, test } from "bun:test";
import { createDeterministicHarness } from "../../harness/providers/deterministic";
import { createRlmHarness } from "../harness";
import type { HarnessEvent } from "../../types";
import type { RlmConfig } from "../types";

function defaultConfig(overrides: Partial<RlmConfig> = {}): RlmConfig {
  return {
    maxIterations: 10,
    maxStdoutLength: 4000,
    metadataPrefixLength: 200,
    ...overrides,
  };
}

async function collectEvents(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("RLM harness", () => {
  describe("simple flow", () => {
    test("model returns FINAL() in first turn — yields correct events", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: 'FINAL("hello world")' }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "say hello" }],
        }),
      );

      const types = events.map((e) => e.type);
      expect(types[0]).toBe("harness_start");
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      expect(types).toContain("text");
      expect(types[types.length - 1]).toBe("harness_end");

      // The final text event should contain the answer
      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toBe("hello world");
      }
    });

    test("code in fenced block is extracted and executed", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: 'Let me compute this.\n```js\nFINAL("computed")\n```',
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "compute something" }],
        }),
      );

      const toolCall = events.find((e) => e.type === "tool_call");
      expect(toolCall).toBeDefined();
      if (toolCall?.type === "tool_call") {
        expect((toolCall.input as { code: string }).code).toBe('FINAL("computed")');
      }

      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toBe("computed");
      }
    });
  });

  describe("multi-turn flow", () => {
    test("model examines context then returns FINAL", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: "print(context.length)" }] },
          { events: [{ type: "text", content: 'FINAL("length is " + context.length)' }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "how long is this?" }],
        }),
      );

      // Should have two tool_call/tool_result pairs
      const toolCalls = events.filter((e) => e.type === "tool_call");
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolCalls.length).toBe(2);
      expect(toolResults.length).toBe(2);

      // First tool_result should have stdout with the length
      if (toolResults[0].type === "tool_result") {
        const output = toolResults[0].output as { stdout: string };
        expect(output.stdout).toBe("17"); // "how long is this?".length
      }

      // Final text event
      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toBe("length is 17");
      }
    });
  });

  describe("maxIterations", () => {
    test("loop terminates when maxIterations reached", async () => {
      // Model never calls FINAL — loop should stop after maxIterations
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: "print(1)" }] },
          { events: [{ type: "text", content: "print(2)" }] },
          { events: [{ type: "text", content: "print(3)" }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig({ maxIterations: 2 }),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test" }],
        }),
      );

      // Should have exactly 2 tool_call/tool_result pairs (maxIterations = 2)
      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls.length).toBe(2);

      // Should still end with harness_end
      expect(events[events.length - 1].type).toBe("harness_end");

      // Should NOT have a text event (no FINAL was called)
      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBe(0);
    });
  });

  describe("error handling", () => {
    test("REPL error does not crash harness — yields error in tool_result", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: "undefinedVar.boom" }] },
          { events: [{ type: "text", content: 'FINAL("recovered")' }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test" }],
        }),
      );

      // First tool_result should have an error
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults.length).toBe(2);
      if (toolResults[0].type === "tool_result") {
        const output = toolResults[0].output as { error: string };
        expect(output.error).toBeDefined();
      }

      // Should still recover and get final answer
      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toBe("recovered");
      }
    });
  });

  describe("llm_query integration", () => {
    test("code that calls llm_query gets a response from sub-harness", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: 'scope.answer = await llm_query("what is 2+2?");\nFINAL(scope.answer);',
              },
            ],
          },
        ],
      });

      const subHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: "4" }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        subHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test" }],
        }),
      );

      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toBe("4");
      }
    });
  });

  describe("event ordering", () => {
    test("events follow harness_start → tool_call/tool_result pairs → text → harness_end", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: 'FINAL("done")' }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test" }],
        }),
      );

      const types = events.map((e) => e.type);

      // First event: harness_start
      expect(types[0]).toBe("harness_start");

      // Then tool_call, tool_result pair
      const toolCallIdx = types.indexOf("tool_call");
      const toolResultIdx = types.indexOf("tool_result");
      expect(toolCallIdx).toBeGreaterThan(0);
      expect(toolResultIdx).toBeGreaterThan(toolCallIdx);

      // Then text (final answer)
      const textIdx = types.indexOf("text");
      expect(textIdx).toBeGreaterThan(toolResultIdx);

      // Last event: harness_end
      expect(types[types.length - 1]).toBe("harness_end");
    });

    test("all events share the same runId", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: 'FINAL("done")' }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test" }],
        }),
      );

      const runIds = new Set(events.map((e) => e.runId));
      expect(runIds.size).toBe(1);
    });
  });

  describe("context access", () => {
    test("user prompt is accessible as context in REPL", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: "FINAL(context)" }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "the secret message" }],
        }),
      );

      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toBe("the secret message");
      }
    });
  });
});
