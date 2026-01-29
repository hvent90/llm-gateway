import { describe, test, expect } from "bun:test";
import type { HarnessEvent } from "../../../types";
import { createDeterministicHarness } from "../deterministic";

async function collectEvents(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("Deterministic Harness", () => {
  test("yields text events from scripted response", async () => {
    const harness = createDeterministicHarness({
      responses: [{ events: [{ type: "text", content: "Hello world" }] }],
    });

    const events = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
    expect((events[0] as { content: string }).content).toBe("Hello world");
  });

  test("yields reasoning events", async () => {
    const harness = createDeterministicHarness({
      responses: [{ events: [{ type: "reasoning", content: "Let me think..." }] }],
    });

    const events = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "think" }] }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("reasoning");
    expect((events[0] as { content: string }).content).toBe("Let me think...");
  });

  test("yields tool_call events", async () => {
    const harness = createDeterministicHarness({
      responses: [
        {
          events: [{ type: "tool_call", name: "bash", input: { command: "echo hello" } }],
        },
      ],
    });

    const events = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "run it" }] }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_call");
    const tc = events[0] as { name: string; input: unknown };
    expect(tc.name).toBe("bash");
    expect(tc.input).toEqual({ command: "echo hello" });
  });

  test("yields error events and stops", async () => {
    const harness = createDeterministicHarness({
      responses: [
        {
          events: [
            { type: "text", content: "before" },
            { type: "error", message: "boom" },
            { type: "text", content: "after" }, // should not be yielded
          ],
        },
      ],
    });

    const events = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "fail" }] }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text");
    expect(events[1]!.type).toBe("error");
    expect((events[1] as { error: Error }).error.message).toBe("boom");
  });

  test("multi-iteration consumption across invoke() calls", async () => {
    const harness = createDeterministicHarness({
      responses: [
        { events: [{ type: "tool_call", name: "greet", input: { name: "Alice" } }] },
        { events: [{ type: "text", content: "Done greeting" }] },
      ],
    });

    // First invoke — tool call
    const first = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "greet" }] }),
    );
    expect(first).toHaveLength(1);
    expect(first[0]!.type).toBe("tool_call");

    // Second invoke — text follow-up
    const second = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "continue" }] }),
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.type).toBe("text");
    expect((second[0] as { content: string }).content).toBe("Done greeting");
  });

  test("each invoke assigns unique runId", async () => {
    const harness = createDeterministicHarness({
      responses: [
        { events: [{ type: "text", content: "a" }] },
        { events: [{ type: "text", content: "b" }] },
      ],
    });

    const first = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "1" }] }),
    );
    const second = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "2" }] }),
    );

    const runId1 = (first[0] as { runId: string }).runId;
    const runId2 = (second[0] as { runId: string }).runId;
    expect(runId1).toBeDefined();
    expect(runId2).toBeDefined();
    expect(runId1).not.toBe(runId2);
  });

  test("forwards context.parentId to yielded events", async () => {
    const harness = createDeterministicHarness({
      responses: [{ events: [{ type: "text", content: "child" }] }],
    });

    const events = await collectEvents(
      harness.invoke({
        model: "deterministic",
        messages: [{ role: "user", content: "hi" }],
        context: { parentId: "parent-123" },
      }),
    );

    expect(events).toHaveLength(1);
    expect((events[0] as { parentId?: string }).parentId).toBe("parent-123");
  });

  test("events without context.parentId have no parentId field", async () => {
    const harness = createDeterministicHarness({
      responses: [{ events: [{ type: "text", content: "root" }] }],
    });

    const events = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toHaveLength(1);
    expect("parentId" in events[0]!).toBe(false);
  });

  test("each event gets a unique id", async () => {
    const harness = createDeterministicHarness({
      responses: [
        {
          events: [
            { type: "text", content: "a" },
            { type: "text", content: "b" },
            { type: "tool_call", name: "x", input: {} },
          ],
        },
      ],
    });

    const events = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "multi" }] }),
    );

    const ids = events.map((e) => (e as { id: string }).id);
    expect(new Set(ids).size).toBe(3);
  });

  test("supportedModels returns configured models", async () => {
    const harness = createDeterministicHarness({
      responses: [],
      models: ["model-a", "model-b"],
    });

    const models = await harness.supportedModels();
    expect(models).toEqual(["model-a", "model-b"]);
  });

  test("supportedModels defaults to ['deterministic']", async () => {
    const harness = createDeterministicHarness({ responses: [] });
    const models = await harness.supportedModels();
    expect(models).toEqual(["deterministic"]);
  });

  test("yields error when responses exhausted", async () => {
    const harness = createDeterministicHarness({ responses: [] });

    const events = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0] as { error: Error }).error.message).toContain("no scripted response");
  });

  test("mixed event types in single response", async () => {
    const harness = createDeterministicHarness({
      responses: [
        {
          events: [
            { type: "reasoning", content: "thinking..." },
            { type: "text", content: "Hello " },
            { type: "text", content: "world" },
            { type: "tool_call", name: "bash", input: { command: "ls" } },
          ],
        },
      ],
    });

    const events = await collectEvents(
      harness.invoke({ model: "deterministic", messages: [{ role: "user", content: "go" }] }),
    );

    expect(events).toHaveLength(4);
    expect(events[0]!.type).toBe("reasoning");
    expect(events[1]!.type).toBe("text");
    expect(events[2]!.type).toBe("text");
    expect(events[3]!.type).toBe("tool_call");
  });
});
