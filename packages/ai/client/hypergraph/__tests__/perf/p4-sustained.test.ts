import { describe, test, expect } from "bun:test";
import { generateEvalSession } from "./generators";
import { benchFullPipeline } from "./timing";

// ---------------------------------------------------------------------------
// P4: Sustained session viability
//
// Simulate the full reduce -> project -> flatten pipeline for a realistic
// eval session. No single event should take > 50ms through the full pipeline.
// This is the integration benchmark that reproduces the freeze and proves the
// fix works.
//
// Note: benchFullPipeline calls projectRepl on EVERY event (worst case).
// In the real eval CLI, projectRepl is called at most ~60fps via Solid.js memo.
// We test both full-pipeline (every event) and throttled (periodic) scenarios.
// ---------------------------------------------------------------------------

const MAX_EVENT_MS = 50;

describe("P4: sustained session viability", () => {
  test("no event > 50ms through full pipeline (100 turns, 50 progress)", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 50, numRuns: 1 });
    const result = benchFullPipeline(events);

    const overallMaxMs = Math.max(...result.allTimes) / 1000;
    expect(overallMaxMs).toBeLessThan(MAX_EVENT_MS);

    // Last 10% median should be under 16ms (one frame budget)
    const lastMedianMs = result.buckets[2]!.median / 1000;
    expect(lastMedianMs).toBeLessThan(16);
  }, 30_000);

  test("no event > 50ms at end of large session (200 turns, 100 progress)", () => {
    // Full pipeline on every event would take ~120s at this size.
    // Instead, build the full graph first, then measure per-event cost
    // for the last batch (simulating the "end of session" freeze scenario).
    const events = generateEvalSession({ turns: 200, progressChunksPerTurn: 100, numRuns: 1 });

    // Process events in two phases: bulk reduce, then pipeline the last N
    const { reduceConversation, createInitialConversation } = require("../../conversation");
    const { projectRepl } = require("../../projections/repl");
    const { flattenAgents } = require("../../../../../../packages/ui/cli/repl/sidebar");

    let state = createInitialConversation();
    const lastN = 500; // Test the last 500 events
    const bulkEnd = events.length - lastN;

    // Bulk reduce without projection (simulates the session up to this point)
    for (let i = 0; i < bulkEnd; i++) {
      state = reduceConversation(state, events[i] as any);
    }

    // Now pipeline the last N events and measure each
    const times: number[] = [];
    for (let i = bulkEnd; i < events.length; i++) {
      const start = performance.now();
      state = reduceConversation(state, events[i] as any);
      const replData = projectRepl(state.graph);
      flattenAgents(replData.agents);
      times.push((performance.now() - start) * 1000);
    }

    const maxMs = Math.max(...times) / 1000;
    expect(maxMs).toBeLessThan(MAX_EVENT_MS);

    // Median of last batch should be usable
    const sorted = [...times].sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)]! / 1000;
    expect(medianMs).toBeLessThan(16);
  }, 60_000);

  test("no event > 50ms at end of multi-agent session (30 turns, 50 progress, 3 runs)", () => {
    const events = generateEvalSession({ turns: 30, progressChunksPerTurn: 50, numRuns: 3 });
    const result = benchFullPipeline(events);

    const overallMaxMs = Math.max(...result.allTimes) / 1000;
    expect(overallMaxMs).toBeLessThan(MAX_EVENT_MS);
  }, 30_000);

  test("per-event cost at end of session remains usable", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 50, numRuns: 1 });
    const result = benchFullPipeline(events);

    // Last 10% median should be under 16ms (one frame budget)
    const lastMedianMs = result.buckets[2]!.median / 1000;
    expect(lastMedianMs).toBeLessThan(16);

    // Total session should complete in reasonable time
    expect(result.totalTimeMs).toBeLessThan(30000);
  }, 30_000);
});
