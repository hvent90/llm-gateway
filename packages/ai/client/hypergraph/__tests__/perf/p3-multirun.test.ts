import { describe, test, expect } from "bun:test";
import { generateEvalSession } from "./generators";
import { benchProjectRepl } from "./timing";

// ---------------------------------------------------------------------------
// P3: Multi-run cost scales with runs not graph size
//
// Adding more runIds (subagents) should scale with the number of runs,
// not with total graph size times number of runs. This targets the
// collectRunChunks inner loop which currently iterates ALL nodes to
// find the start chunk for each runId.
//
// Test: doubling the number of runs should roughly double cost, not quadruple.
// ---------------------------------------------------------------------------

describe("P3: multi-run scaling", () => {
  test("doubling runs roughly doubles cost (not quadruples)", () => {
    const base = { turns: 20, progressChunksPerTurn: 30, numRuns: 2 };
    const doubled = { turns: 20, progressChunksPerTurn: 30, numRuns: 4 };

    const baseResult = benchProjectRepl(generateEvalSession(base), 50);
    const doubledResult = benchProjectRepl(generateEvalSession(doubled), 50);

    // With O(runs * nodes): doubling runs with ~2x nodes = ~4x cost
    // With O(runs): doubling runs = ~2x cost
    // Allow up to 3x to account for the larger graph having more work
    const ratio = doubledResult.median / Math.max(1, baseResult.median);
    expect(ratio).toBeLessThan(3);
  });

  test("projectRepl cost with 5 runs vs 1 run: less than 8x increase", () => {
    const single = { turns: 30, progressChunksPerTurn: 40, numRuns: 1 };
    const multi = { turns: 30, progressChunksPerTurn: 40, numRuns: 5 };

    const singleResult = benchProjectRepl(generateEvalSession(single), 50);
    const multiResult = benchProjectRepl(generateEvalSession(multi), 50);

    // 5 runs with 5x more total events
    // O(runs * nodes) would give ~25x (5 runs * 5x nodes)
    // O(runs) would give ~5x
    // Allow 8x to be generous
    const ratio = multiResult.median / Math.max(1, singleResult.median);
    expect(ratio).toBeLessThan(8);
  });
});
