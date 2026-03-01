import { describe, expect, test } from "bun:test";
import { createDeterministicHarness } from "../../harness/providers/deterministic";
import { createRlmHarness } from "../harness";
import type { HarnessEvent, RelayEvent } from "../../types";
import type { RlmConfig } from "../types";

/** Wrap code in a fenced ```js block, as extractCode now requires. */
function fence(code: string): string {
  return "```js\n" + code + "\n```";
}

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

/** Find the FINAL answer text — the last text event (emitted after repl_output with done=true). */
function findFinalText(events: HarnessEvent[]): string | undefined {
  const textEvents = events.filter((e) => e.type === "text");
  const last = textEvents[textEvents.length - 1];
  return last?.type === "text" ? last.content : undefined;
}

describe("RLM harness", () => {
  describe("simple flow", () => {
    test("model returns FINAL() in first turn — yields correct events", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: fence('FINAL("hello world")') }] }],
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
      expect(types).toContain("repl_input");
      expect(types).toContain("repl_output");
      expect(types).toContain("text");
      expect(types[types.length - 1]).toBe("harness_end");

      // The final text event should contain the answer
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("hello world");
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

      const replInput = events.find((e) => e.type === "repl_input");
      expect(replInput).toBeDefined();
      if (replInput?.type === "repl_input") {
        expect(replInput.code).toBe('FINAL("computed")');
      }

      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("computed");
      }
    });
  });

  describe("multi-turn flow", () => {
    test("model examines context then returns FINAL", async () => {
      const contextData = "how long is this?";
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: fence("console.log(context.length)") }] },
          { events: [{ type: "text", content: fence('FINAL("length is " + context.length)') }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          context: contextData,
          messages: [{ role: "user", content: "What is the length of the context?" }],
        }),
      );

      // Should have two repl_input/repl_output pairs
      const toolCalls = events.filter((e) => e.type === "repl_input");
      const toolResults = events.filter((e) => e.type === "repl_output");
      expect(toolCalls.length).toBe(2);
      expect(toolResults.length).toBe(2);

      // First repl_output should have stdout with the length
      if (toolResults[0].type === "repl_output") {
        expect(toolResults[0].stdout).toBe("17"); // "how long is this?".length
      }

      // Final text event
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("length is 17");
      }
    });
  });

  describe("maxIterations", () => {
    test("loop terminates when maxIterations reached", async () => {
      // Model never calls FINAL — loop should stop after maxIterations
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: fence("console.log(1)") }] },
          { events: [{ type: "text", content: fence("console.log(2)") }] },
          { events: [{ type: "text", content: fence("console.log(3)") }] },
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

      // Should have exactly 2 repl_input/repl_output pairs (maxIterations = 2)
      const toolCalls = events.filter((e) => e.type === "repl_input");
      expect(toolCalls.length).toBe(2);

      // Should still end with harness_end
      expect(events[events.length - 1].type).toBe("harness_end");

      // Text events from LLM streaming are present, but no repl_output should have done=true
      const replOutputs = events.filter((e) => e.type === "repl_output");
      for (const o of replOutputs) {
        if (o.type === "repl_output") expect(o.done).toBe(false);
      }
    });
  });

  describe("multiple code blocks", () => {
    test("model returning multiple code blocks gets error feedback and can recover", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: '```js\nconsole.log("first")\n```\n```js\nconsole.log("second")\n```',
              },
            ],
          },
          { events: [{ type: "text", content: fence('FINAL("recovered")') }] },
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

      // No repl_input for the rejected turn
      const replInputs = events.filter((e) => e.type === "repl_input");
      expect(replInputs.length).toBe(1);

      // Should recover with FINAL in second turn
      const textEvents = events.filter((e) => e.type === "text" && e.content === "recovered");
      expect(textEvents.length).toBe(1);
    });
  });

  describe("error handling", () => {
    test("REPL error does not crash harness — yields error in repl_output", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: fence("undefinedVar.boom") }] },
          { events: [{ type: "text", content: fence('FINAL("recovered")') }] },
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

      // First repl_output should have an error
      const replOutputs = events.filter((e) => e.type === "repl_output");
      expect(replOutputs.length).toBe(2);
      if (replOutputs[0].type === "repl_output") {
        expect(replOutputs[0].error).toBeDefined();
      }

      // Should still recover and get final answer
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("recovered");
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
                content: fence('scope.answer = await llm_query("what is 2+2?");\nFINAL(scope.answer);'),
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
        config: defaultConfig({ maxDepth: 0 }),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test" }],
        }),
      );

      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("4");
      }
    });
  });

  describe("event ordering", () => {
    test("events follow harness_start → text(streamed) → repl_input → repl_output → text(FINAL) → harness_end", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: fence('FINAL("done")') }] }],
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

      // Streamed text comes before repl_input
      const firstTextIdx = types.indexOf("text");
      const replInputIdx = types.indexOf("repl_input");
      const replOutputIdx = types.indexOf("repl_output");
      expect(firstTextIdx).toBeGreaterThan(0);
      expect(replInputIdx).toBeGreaterThan(firstTextIdx);
      expect(replOutputIdx).toBeGreaterThan(replInputIdx);

      // FINAL text comes after repl_output
      const lastTextIdx = types.lastIndexOf("text");
      expect(lastTextIdx).toBeGreaterThan(replOutputIdx);

      // Last event: harness_end
      expect(types[types.length - 1]).toBe("harness_end");
    });

    test("all events share the same runId", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: fence('FINAL("done")') }] }],
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

  describe("exec integration", () => {
    test("code that calls exec gets shell output", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("echo hello");\nFINAL(r.stdout.trim());'),
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
          messages: [{ role: "user", content: "test exec" }],
        }),
      );

      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("hello");
      }
    });
  });

  describe("context access", () => {
    test("context field is accessible as context in REPL", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: fence("FINAL(context)") }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({
          context: "the secret message",
          messages: [{ role: "user", content: "Return the context" }],
        }),
      );

      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("the secret message");
      }
    });
  });

  describe("exec HITL relay", () => {
    /** Collect events, auto-handling relay events via onRelay callback. */
    async function collectEventsWithRelays(
      iterable: AsyncIterable<HarnessEvent>,
      onRelay: (event: RelayEvent) => void,
    ): Promise<HarnessEvent[]> {
      const events: HarnessEvent[] = [];
      for await (const event of iterable) {
        events.push(event);
        if (event.type === "relay") onRelay(event);
      }
      return events;
    }

    test("exec yields relay when permissions provided with empty allowlist", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("echo hitl");\nFINAL(r.stdout.trim());'),
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const relays: RelayEvent[] = [];
      const events = await collectEventsWithRelays(
        rlm.invoke({
          messages: [{ role: "user", content: "test exec hitl" }],
          permissions: { allowlist: [] },
        }),
        (relay) => {
          relays.push(relay);
          relay.respond({ approved: true });
        },
      );

      // Should have exactly one relay event for exec
      expect(relays.length).toBe(1);
      expect(relays[0].tool).toBe("exec");
      expect(relays[0].params).toEqual({ command: "echo hitl" });

      // Should still get final result after approval
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("hitl");
      }
    });

    test("denied exec surfaces as REPL error", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("rm -rf /");\nFINAL(r.stdout);'),
              },
            ],
          },
          {
            events: [
              {
                type: "text",
                content: fence('FINAL("recovered after denial")'),
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEventsWithRelays(
        rlm.invoke({
          messages: [{ role: "user", content: "test denied exec" }],
          permissions: { allowlist: [] },
        }),
        (relay) => {
          relay.respond({ approved: false, reason: "dangerous command" });
        },
      );

      // First repl_output should contain the denial error
      const replOutputs = events.filter((e) => e.type === "repl_output");
      expect(replOutputs.length).toBe(2);
      if (replOutputs[0].type === "repl_output") {
        expect(replOutputs[0].error).toContain("exec denied");
      }

      // Model recovers in second turn
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("recovered after denial");
      }
    });

    test("exec auto-approved via allowlist — no relay event", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("echo allowed");\nFINAL(r.stdout.trim());'),
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const relays: RelayEvent[] = [];
      const events = await collectEventsWithRelays(
        rlm.invoke({
          messages: [{ role: "user", content: "test auto-approved exec" }],
          permissions: { allowlist: [{ tool: "exec" }] },
        }),
        (relay) => {
          relays.push(relay);
          relay.respond({ approved: true });
        },
      );

      // No relay events — exec is pre-approved
      expect(relays.length).toBe(0);

      // Should get final result
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("allowed");
      }
    });

    test("no relay when permissions absent — backward compat", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("echo free");\nFINAL(r.stdout.trim());'),
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const relays: RelayEvent[] = [];
      const events = await collectEventsWithRelays(
        rlm.invoke({
          messages: [{ role: "user", content: "test no permissions" }],
          // No permissions field — exec runs freely
        }),
        (relay) => {
          relays.push(relay);
          relay.respond({ approved: true });
        },
      );

      // No relay events
      expect(relays.length).toBe(0);

      // Should get final result
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("free");
      }
    });
  });

  describe("exec streaming", () => {
    test("exec produces repl_progress events with stdout chunks", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence(
                  'const r = await exec("echo hello && sleep 0.1 && echo world");\nFINAL(r.stdout.trim());',
                ),
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
          messages: [{ role: "user", content: "test streaming" }],
        }),
      );

      // Should have repl_progress events between repl_input and repl_output
      const progressEvents = events.filter((e) => e.type === "repl_progress");
      expect(progressEvents.length).toBeGreaterThan(0);

      // Progress events should have stdout chunks
      const stdoutProgress = progressEvents.filter(
        (e) => e.type === "repl_progress" && e.stream === "stdout",
      );
      expect(stdoutProgress.length).toBeGreaterThan(0);

      // Final result should still work
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toContain("hello");
        expect(finalText).toContain("world");
      }
    });

    test("exec produces metrics events for long-running commands", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("sleep 2 && echo done");\nFINAL(r.stdout.trim());'),
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig({ execTimeout: 5 }),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test metrics" }],
        }),
      );

      // Should have at least 1 metrics event (1s poll, command takes ~2s)
      const metricsEvents = events.filter(
        (e) => e.type === "repl_progress" && e.stream === "stderr" && e.chunk.includes("[exec]"),
      );
      expect(metricsEvents.length).toBeGreaterThanOrEqual(1);

      // Metrics should contain process info
      const m = metricsEvents[0];
      if (m.type === "repl_progress") {
        expect(m.chunk).toMatch(/pid=\d+/);
        expect(m.chunk).toMatch(/cpu=[\d.]+%/);
        expect(m.chunk).toMatch(/rss=\d+KB/);
        expect(m.chunk).toMatch(/wall=\d+ms/);
      }

      // Final result should still work
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("done");
      }
    });

    test("exec streams stderr via repl_progress", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence(
                  'const r = await exec("echo err >&2 && echo out");\nFINAL(r.stdout.trim());',
                ),
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
          messages: [{ role: "user", content: "test stderr" }],
        }),
      );

      const progressEvents = events.filter((e) => e.type === "repl_progress");

      const stderrProgress = progressEvents.filter(
        (e) => e.type === "repl_progress" && e.stream === "stderr",
      );
      expect(stderrProgress.length).toBeGreaterThan(0);

      const stderrContent = stderrProgress
        .map((e) => (e.type === "repl_progress" ? e.chunk : ""))
        .join("");
      expect(stderrContent).toContain("err");
    });

    test("repl_progress events appear between repl_input and repl_output", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("echo ordering");\nFINAL(r.stdout.trim());'),
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
          messages: [{ role: "user", content: "test ordering" }],
        }),
      );

      const types = events.map((e) => e.type);
      const toolCallIdx = types.indexOf("repl_input");
      const toolResultIdx = types.indexOf("repl_output");
      const progressIdx = types.indexOf("repl_progress");

      expect(progressIdx).toBeGreaterThan(toolCallIdx);
      expect(progressIdx).toBeLessThan(toolResultIdx);
    });

    test("exec streaming works alongside HITL relay", async () => {
      /** Collect events, auto-handling relay events via onRelay callback. */
      async function collectEventsWithRelays(
        iterable: AsyncIterable<HarnessEvent>,
        onRelay: (event: RelayEvent) => void,
      ): Promise<HarnessEvent[]> {
        const events: HarnessEvent[] = [];
        for await (const event of iterable) {
          events.push(event);
          if (event.type === "relay") onRelay(event);
        }
        return events;
      }

      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("echo relayed");\nFINAL(r.stdout.trim());'),
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const relays: RelayEvent[] = [];
      const events = await collectEventsWithRelays(
        rlm.invoke({
          messages: [{ role: "user", content: "test streaming with relay" }],
          permissions: { allowlist: [] },
        }),
        (relay) => {
          relays.push(relay);
          relay.respond({ approved: true });
        },
      );

      // Should have relay event
      expect(relays.length).toBe(1);

      // Should also have repl_progress events
      const progressEvents = events.filter((e) => e.type === "repl_progress");
      expect(progressEvents.length).toBeGreaterThan(0);

      // Final result should work
      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("relayed");
      }
    });

    test("repl_progress events share runId with repl_input", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('const r = await exec("echo linked");\nFINAL(r.stdout.trim());'),
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
          messages: [{ role: "user", content: "test linkage" }],
        }),
      );

      const replInput = events.find((e) => e.type === "repl_input");
      const progressEvents = events.filter((e) => e.type === "repl_progress");

      expect(replInput).toBeDefined();
      expect(progressEvents.length).toBeGreaterThan(0);

      // All events share the same runId
      for (const p of progressEvents) {
        expect(p.runId).toBe(replInput!.runId);
      }
    });
  });

  describe("observability", () => {
    test("repl_input and repl_output carry iteration index", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: fence("console.log(1)") }] },
          { events: [{ type: "text", content: fence('FINAL("done")') }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const replInputs = events.filter((e) => e.type === "repl_input");
      const replOutputs = events.filter((e) => e.type === "repl_output");
      expect(replInputs.length).toBe(2);
      expect(replOutputs.length).toBe(2);

      if (replInputs[0].type === "repl_input") expect(replInputs[0].iteration).toBe(0);
      if (replInputs[1].type === "repl_input") expect(replInputs[1].iteration).toBe(1);
      if (replOutputs[0].type === "repl_output") expect(replOutputs[0].iteration).toBe(0);
      if (replOutputs[1].type === "repl_output") expect(replOutputs[1].iteration).toBe(1);
    });

    test("repl_output carries durationMs >= 0", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: fence('FINAL("done")') }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const replOutput = events.find((e) => e.type === "repl_output");
      expect(replOutput).toBeDefined();
      if (replOutput?.type === "repl_output") {
        expect(replOutput.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    test("repl_output carries truncated: true when stdout is truncated", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: fence('console.log("x".repeat(5000))') }] },
          { events: [{ type: "text", content: fence('FINAL("done")') }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig({ maxStdoutLength: 20 }),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const replOutputs = events.filter((e) => e.type === "repl_output");
      expect(replOutputs.length).toBe(2);
      if (replOutputs[0].type === "repl_output") {
        expect(replOutputs[0].truncated).toBe(true);
      }
    });

    test("code extraction failure yields an error event", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: '```js\nconsole.log("a")\n```\n```js\nconsole.log("b")\n```',
              },
            ],
          },
          { events: [{ type: "text", content: '```js\nFINAL("ok")\n```' }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(1);
      if (errorEvents[0].type === "error") {
        expect(errorEvents[0].error.message).toContain("multiple code blocks");
      }
    });

    test("response without code block yields an error event", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: "I think the answer is 42.",
              },
            ],
          },
          { events: [{ type: "text", content: '```js\nFINAL("recovered")\n```' }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      // Should yield an error event for the missing code block
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBe(1);
      if (errorEvents[0].type === "error") {
        expect(errorEvents[0].error.message).toContain("no code block");
      }

      // No repl_input for the rejected turn
      const replInputs = events.filter((e) => e.type === "repl_input");
      expect(replInputs.length).toBe(1);

      // Should recover in second turn
      const finalText = findFinalText(events);
      expect(finalText).toBe("recovered");
    });

    test("harness_start carries maxIterations", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: fence('FINAL("done")') }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig({ maxIterations: 5 }),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const start = events.find((e) => e.type === "harness_start");
      expect(start).toBeDefined();
      if (start?.type === "harness_start") {
        expect(start.maxIterations).toBe(5);
      }
    });

    test("harness_end has reason: 'final' when FINAL() called", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: fence('FINAL("done")') }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const end = events.find((e) => e.type === "harness_end");
      expect(end).toBeDefined();
      if (end?.type === "harness_end") {
        expect(end.reason).toBe("final");
      }
    });

    test("harness_end has reason: 'max_iterations' when loop exhausted", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: fence("console.log(1)") }] },
          { events: [{ type: "text", content: fence("console.log(2)") }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig({ maxIterations: 2 }),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const end = events.find((e) => e.type === "harness_end");
      expect(end).toBeDefined();
      if (end?.type === "harness_end") {
        expect(end.reason).toBe("max_iterations");
      }
    });

    test("harness_end carries iterations count", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          { events: [{ type: "text", content: fence("console.log(1)") }] },
          { events: [{ type: "text", content: fence('FINAL("done")') }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const end = events.find((e) => e.type === "harness_end");
      expect(end).toBeDefined();
      if (end?.type === "harness_end") {
        expect(end.iterations).toBe(2);
      }
    });

    test("harness_end carries totalUsage from root LLM calls", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              { type: "text", content: fence('FINAL("done")') },
              { type: "usage", inputTokens: 100, outputTokens: 50 },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const end = events.find((e) => e.type === "harness_end");
      expect(end).toBeDefined();
      if (end?.type === "harness_end") {
        expect(end.totalUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
      }
    });

    test("totalUsage accumulates across multiple iterations", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              { type: "text", content: fence("console.log(1)") },
              { type: "usage", inputTokens: 100, outputTokens: 50 },
            ],
          },
          {
            events: [
              { type: "text", content: fence('FINAL("done")') },
              { type: "usage", inputTokens: 200, outputTokens: 80 },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      const end = events.find((e) => e.type === "harness_end");
      expect(end).toBeDefined();
      if (end?.type === "harness_end") {
        expect(end.totalUsage).toEqual({ inputTokens: 300, outputTokens: 130 });
      }
    });

    test("usage events from flat llm_query are forwarded and accumulated", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('scope.answer = await llm_query("q");\nFINAL(scope.answer);'),
              },
              { type: "usage", inputTokens: 100, outputTokens: 50 },
            ],
          },
        ],
      });

      const subHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              { type: "text", content: "sub response" },
              { type: "usage", inputTokens: 30, outputTokens: 20 },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        subHarness,
        config: defaultConfig({ maxDepth: 0 }),
      });

      const events = await collectEvents(
        rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
      );

      // Sub-harness usage should be forwarded as a usage event
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents.length).toBe(2); // root + sub

      const end = events.find((e) => e.type === "harness_end");
      if (end?.type === "harness_end") {
        expect(end.totalUsage).toEqual({ inputTokens: 130, outputTokens: 70 });
      }
    });
  });

  describe("recursive llm_query", () => {
    test("llm_query at depth > 0 spawns child RLM that iterates and returns", async () => {
      // Parent RLM: model calls llm_query("child task", "child data") then FINALs the result
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence(
                  'scope.answer = await llm_query("child task", "child data");\nFINAL(scope.answer);',
                ),
              },
            ],
          },
        ],
      });

      // Child RLM (sub-harness): gets "child data" as context, "child task" as user message
      const subHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          // Child turn 1: examine context
          { events: [{ type: "text", content: fence("console.log(context)") }] },
          // Child turn 2: return final answer
          { events: [{ type: "text", content: fence('FINAL("child result: " + context)') }] },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        subHarness,
        config: defaultConfig({ maxDepth: 1 }),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "parent task" }],
        }),
      );

      // Parent should yield the child's final answer
      const parentTextEvents = events.filter(
        (e) => e.type === "text" && !("parentId" in e && e.parentId !== undefined),
      );
      const parentFinalText = parentTextEvents[parentTextEvents.length - 1];
      expect(parentFinalText).toBeDefined();
      if (parentFinalText?.type === "text") {
        expect(parentFinalText.content).toBe("child result: child data");
      }

      // Child events should bubble up as progress (harness_start, repl_input, repl_output, text, harness_end)
      const childEvents = events.filter((e) => "parentId" in e && e.parentId !== undefined);
      expect(childEvents.length).toBeGreaterThan(0);

      // Child events should include repl_input events from the child REPL
      const childReplInputs = childEvents.filter((e) => e.type === "repl_input");
      expect(childReplInputs.length).toBe(2); // two child REPL turns
    });

    test("llm_query at depth 0 falls back to flat one-shot call", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content: fence('scope.answer = await llm_query("flat query");\nFINAL(scope.answer);'),
              },
            ],
          },
        ],
      });

      const subHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [{ events: [{ type: "text", content: "flat response" }] }],
      });

      const rlm = createRlmHarness({
        rootHarness,
        subHarness,
        config: defaultConfig({ maxDepth: 0 }),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test" }],
        }),
      );

      const finalText = findFinalText(events);
      expect(finalText).toBeDefined();
      {
        expect(finalText).toBe("flat response");
      }

      // No child RLM events should appear (no harness_start from child)
      const childHarnessStarts = events.filter(
        (e) => e.type === "harness_start" && "parentId" in e && e.parentId !== undefined,
      );
      expect(childHarnessStarts.length).toBe(0);
    });
  });
});
