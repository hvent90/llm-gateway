import { describe, test, expect } from "bun:test";
import { generateEvalSession } from "./generators";
import { benchProjectRepl } from "./timing";

// ---------------------------------------------------------------------------
// P2: Projection cost bounded
//
// projectRepl on a large graph must stay under a budget that makes
// terminal updates viable (~16ms). Large = realistic long-running
// eval session: hundreds of turns, thousands of progress chunks.
// ---------------------------------------------------------------------------

const BUDGET_MS = 16;

describe("P2: projection cost bounded", () => {
  test("projectRepl < 16ms on 100 turns, 50 progress/turn (5300 nodes)", () => {
    const events = generateEvalSession({ turns: 100, progressChunksPerTurn: 50, numRuns: 1 });
    const result = benchProjectRepl(events, 100);

    // Use median across 100 calls to smooth out JIT/GC noise
    const medianMs = result.median / 1000;
    expect(medianMs).toBeLessThan(BUDGET_MS);
  });

  test("projectRepl < 16ms on 200 turns, 100 progress/turn (20600 nodes)", () => {
    const events = generateEvalSession({ turns: 200, progressChunksPerTurn: 100, numRuns: 1 });
    const result = benchProjectRepl(events, 50);

    const medianMs = result.median / 1000;
    expect(medianMs).toBeLessThan(BUDGET_MS);
  });

  test("projectRepl < 16ms on 50 turns, 200 progress/turn, 3 runs (multi-agent)", () => {
    const events = generateEvalSession({ turns: 50, progressChunksPerTurn: 200, numRuns: 3 });
    const result = benchProjectRepl(events, 50);

    const medianMs = result.median / 1000;
    expect(medianMs).toBeLessThan(BUDGET_MS);
  });
});
