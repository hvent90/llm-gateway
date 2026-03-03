import { describe, test, expect } from "bun:test";
import { generateEvalSession } from "./generators";
import { benchReduceEvent, benchReduceConversation } from "./timing";

// ---------------------------------------------------------------------------
// P1: Sublinear degradation
//
// The cost of processing the Nth event must not scale linearly with N.
// Specifically: the per-event cost of the last 10% of a long stream
// should not be dramatically more expensive than the first 10%.
//
// Threshold: last-10%-median / first-10%-median < 5x
// (A truly O(N) system would show 10x+ degradation at scale)
// ---------------------------------------------------------------------------

const DEGRADATION_THRESHOLD = 5;

describe("P1: sublinear degradation", () => {
  test("reduceEvent: last 10% no more than 5x the first 10% (100 turns, 50 progress/turn)", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 50, numRuns: 1 });
    const result = benchReduceEvent(events);

    const firstMedian = result.buckets[0]!.median;
    const lastMedian = result.buckets[2]!.median;
    const ratio = lastMedian / Math.max(1, firstMedian);

    expect(ratio).toBeLessThan(DEGRADATION_THRESHOLD);
  });

  test("reduceConversation: last 10% no more than 5x the first 10% (100 turns, 50 progress/turn)", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 50, numRuns: 1 });
    const result = benchReduceConversation(events);

    const firstMedian = result.buckets[0]!.median;
    const lastMedian = result.buckets[2]!.median;
    const ratio = lastMedian / Math.max(1, firstMedian);

    expect(ratio).toBeLessThan(DEGRADATION_THRESHOLD);
  });

  test("reduceEvent: scales with larger stream (200 turns, 100 progress/turn)", () => {
    const events = generateEvalSession({ turns: 200, progressChunksPerTurn: 100, numRuns: 1 });
    const result = benchReduceEvent(events);

    const firstMedian = result.buckets[0]!.median;
    const lastMedian = result.buckets[2]!.median;
    const ratio = lastMedian / Math.max(1, firstMedian);

    expect(ratio).toBeLessThan(DEGRADATION_THRESHOLD);
  });

  test("reduceConversation: scales with larger stream (200 turns, 100 progress/turn)", () => {
    const events = generateEvalSession({ turns: 200, progressChunksPerTurn: 100, numRuns: 1 });
    const result = benchReduceConversation(events);

    const firstMedian = result.buckets[0]!.median;
    const lastMedian = result.buckets[2]!.median;
    const ratio = lastMedian / Math.max(1, firstMedian);

    expect(ratio).toBeLessThan(DEGRADATION_THRESHOLD);
  });
});
