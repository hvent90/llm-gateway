import { describe, test, expect } from "bun:test";
import { generateEvalSession, expectedEventCount } from "./generators";
import {
  benchReduceEvent,
  benchReduceConversation,
  benchProjectRepl,
  benchFullPipeline,
} from "./timing";

// ---------------------------------------------------------------------------
// P0: Benchmark infrastructure — verify generators and timing harness work
// ---------------------------------------------------------------------------

describe("P0: generators", () => {
  test("single-run generates correct event count", () => {
    const params = { turns: 5, progressChunksPerTurn: 10, numRuns: 1 };
    const events = generateEvalSession(params);
    expect(events.length).toBe(expectedEventCount(params));
    // Per run: 1 + 5*(2+10+1) + 1 = 67
    expect(events.length).toBe(67);
  });

  test("multi-run generates correct event count", () => {
    const params = { turns: 3, progressChunksPerTurn: 5, numRuns: 2 };
    const events = generateEvalSession(params);
    expect(events.length).toBe(expectedEventCount(params));
  });

  test("events have correct structure", () => {
    const events = generateEvalSession({ turns: 2, progressChunksPerTurn: 3, numRuns: 1 });
    expect(events[0]!.type).toBe("harness_start");
    expect(events[events.length - 1]!.type).toBe("harness_end");

    // Verify pattern: text, repl_input, progress*3, repl_output repeats
    const inner = events.slice(1, -1);
    const types = inner.map((e) => e.type);
    expect(types[0]).toBe("text");
    expect(types[1]).toBe("repl_input");
    expect(types[2]).toBe("repl_progress");
    expect(types[3]).toBe("repl_progress");
    expect(types[4]).toBe("repl_progress");
    expect(types[5]).toBe("repl_output");
  });

  test("large session generates without error", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 100, numRuns: 1 });
    // 1 + 100*(2+100+1) + 1 = 10302
    expect(events.length).toBe(10302);
  });
});

describe("P0: timing harness", () => {
  test("benchReduceEvent produces valid timing data", () => {
    const events = generateEvalSession({ turns: 10, progressChunksPerTurn: 20, numRuns: 1 });
    const result = benchReduceEvent(events);

    expect(result.totalEvents).toBe(events.length);
    expect(result.totalTimeMs).toBeGreaterThan(0);
    expect(result.allTimes.length).toBe(events.length);
    expect(result.buckets.length).toBe(3);
    expect(result.buckets[0]!.label).toBe("first 10%");
    expect(result.buckets[1]!.label).toBe("middle 80%");
    expect(result.buckets[2]!.label).toBe("last 10%");

    // All times should be non-negative
    for (const t of result.allTimes) {
      expect(t).toBeGreaterThanOrEqual(0);
    }
  });

  test("benchReduceConversation produces valid timing data", () => {
    const events = generateEvalSession({ turns: 10, progressChunksPerTurn: 20, numRuns: 1 });
    const result = benchReduceConversation(events);

    expect(result.totalEvents).toBe(events.length);
    expect(result.buckets.length).toBe(3);
    // reduceConversation includes defaultActive so should be >= reduceEvent
    expect(result.totalTimeMs).toBeGreaterThan(0);
  });

  test("benchProjectRepl produces valid data", () => {
    const events = generateEvalSession({ turns: 5, progressChunksPerTurn: 10, numRuns: 1 });
    const result = benchProjectRepl(events, 10);

    expect(result.times.length).toBe(10);
    expect(result.mean).toBeGreaterThan(0);
    expect(result.data.agents.length).toBe(1);
    expect(result.data.agents[0]!.turns.length).toBe(5);
  });

  test("benchFullPipeline produces valid timing data", () => {
    const events = generateEvalSession({ turns: 5, progressChunksPerTurn: 10, numRuns: 1 });
    const result = benchFullPipeline(events);

    expect(result.totalEvents).toBe(events.length);
    expect(result.buckets.length).toBe(3);
    expect(result.totalTimeMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Baseline measurements — these establish current performance characteristics.
// They pass by design (no assertions on speed), just verify the harness works
// at scale and print numbers for the progress log.
// ---------------------------------------------------------------------------

describe("P0: baseline measurements", () => {
  test("baseline: reduceEvent at scale (100 turns, 50 progress/turn)", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 50, numRuns: 1 });
    const result = benchReduceEvent(events);

    // Just verify it completes and produces data
    expect(result.totalEvents).toBe(events.length);
    expect(result.buckets[0]!.mean).toBeGreaterThan(0);
    expect(result.buckets[2]!.mean).toBeGreaterThan(0);

    // Log degradation ratio for progress tracking
    const ratio = result.buckets[2]!.median / Math.max(1, result.buckets[0]!.median);
    // Store for later properties — no assertion here, just measurement
    expect(ratio).toBeGreaterThan(0);
  });

  test("baseline: reduceConversation at scale", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 50, numRuns: 1 });
    const result = benchReduceConversation(events);

    expect(result.totalEvents).toBe(events.length);
    const ratio = result.buckets[2]!.median / Math.max(1, result.buckets[0]!.median);
    expect(ratio).toBeGreaterThan(0);
  });

  test("baseline: projectRepl on large graph", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 50, numRuns: 1 });
    const result = benchProjectRepl(events, 50);

    expect(result.data.agents.length).toBe(1);
    expect(result.data.agents[0]!.turns.length).toBe(100);
    expect(result.median).toBeGreaterThan(0);
  });

  test("baseline: full pipeline at scale", () => {
    const events = generateEvalSession({ turns: 50, progressChunksPerTurn: 30, numRuns: 1 });
    const result = benchFullPipeline(events);

    expect(result.totalEvents).toBe(events.length);
    const ratio = result.buckets[2]!.median / Math.max(1, result.buckets[0]!.median);
    expect(ratio).toBeGreaterThan(0);
  });

  test("baseline: multi-run scenario", () => {
    const events = generateEvalSession({ turns: 10, progressChunksPerTurn: 20, numRuns: 3 });
    const result = benchReduceConversation(events);

    expect(result.totalEvents).toBe(events.length);
    expect(result.totalTimeMs).toBeGreaterThan(0);

    const projResult = benchProjectRepl(events, 20);
    expect(projResult.data.allAgents.size).toBe(4); // root + 3 children
  });
});
