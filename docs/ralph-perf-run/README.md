# Ralph Perf Run — Hypergraph Performance Optimization

Artifacts from an autonomous "Ralph" run that optimized the hypergraph reducer and REPL projection pipeline. The eval CLI was freezing during long sessions due to O(N^2) work per streaming event. Ralph iterated through a prioritized property list, writing benchmarks and optimizing code until all properties passed.

## What is Ralph?

Ralph is a pattern for autonomous multi-iteration coding: a shell loop invokes `claude --print` with a task spec (RALPH-PERF.md), and the agent works on one property per iteration, commits, updates progress, then exits. The loop re-invokes until all properties pass.

## Files

| File | Purpose |
|------|---------|
| `RALPH-PERF.md` | Agent instructions — the prompt given to Claude on each iteration |
| `perf-prd.json` | Property list with pass/fail status (all passed) |
| `perf-progress.txt` | Iteration-by-iteration progress log with benchmarks and learnings |
| `ralph-perf.sh` | The shell loop that drove the autonomous run |

## Results

All 6 properties were completed in a single session:

- **P0** — Benchmark infrastructure (generators + timing harness)
- **P1** — Sublinear degradation (mutable primitives, incremental active set)
- **P2** — Projection cost bounded (< 16ms for 30K nodes)
- **P3** — Multi-run cost scales with runs not graph size
- **P4** — Sustained session viability (< 50ms per event at 20K events)
- **P5** — Projection correctness preserved (all 195 pre-existing tests pass)

Key optimization: replaced immutable Map copying with in-place mutation + nodeIndex, reducing per-event cost from O(N) to O(1).
