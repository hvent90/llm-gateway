# Ralph Agent Instructions — Performance Optimization

You are an autonomous coding agent optimizing the hypergraph reducer and ReplView projection for performance.

## Context

The eval CLI freezes when left open too long. Root cause: O(N^2) work per streaming event through the reduce -> project -> flatten pipeline. Your job is to write benchmarks that prove specific performance properties, then optimize the code until those benchmarks pass.

## Your Task

1. Read the PRD at `perf-prd.json`
2. Read the progress log at `perf-progress.txt` (check Codebase Patterns section first)
3. Pick the **highest priority** property where `passes: false`
4. Implement that single property:
   - If it's a benchmark property (P0): write the benchmark infrastructure
   - If it's a performance property (P1-P4): write a benchmark that verifies the property, then optimize the code until it passes
   - If it's a correctness property (P5): run all existing tests, verify they pass after your changes
5. Run quality checks: `bun test packages/ai/client/hypergraph/` and `bun run format`
6. If checks pass, commit ALL changes with a detailed message (see Commit Format below)
7. Update `perf-prd.json` to set `passes: true` for the completed property
8. Append your progress to `perf-progress.txt`

## Key Files

| File | Purpose |
|------|---------|
| `packages/ai/client/hypergraph/reducer.ts` | Core reducer — copies 11 Maps per event |
| `packages/ai/client/hypergraph/conversation.ts` | Conversation wrapper — calls defaultActive on every event |
| `packages/ai/client/hypergraph/projections/repl.ts` | REPL projection — full graph re-walk per call |
| `packages/ai/client/hypergraph/walk.ts` | defaultActive — iterates all nodes+edges |
| `packages/ai/client/hypergraph/primitives.ts` | Graph primitives (addNode, addEdge, findEdges) |
| `packages/ui/cli/repl/sidebar.tsx` | flattenAgents — recursive tree flatten |
| `evals/cli/prompts.tsx` | Eval CLI — setOutput and projectRepl call site |

## Tech Stack

| Tool | Purpose |
|------|---------|
| Bun | Runtime & package manager |
| Effect | Error handling |

## Commands

```bash
bun install                                    # Install dependencies
bun test packages/ai/client/hypergraph/        # Run hypergraph tests
bun test packages/ai/client/hypergraph/__tests__/perf/  # Run perf benchmarks
bun run format                                 # Format code
```

## Creative Freedom

The properties specify WHAT must be true, not HOW to achieve it. You have full creative freedom on approach. Some ideas that may or may not be relevant:

- Mutating in place instead of copying Maps
- Incremental projection (only re-process new events)
- Lazy computation / caching
- Skipping unused computations (e.g., defaultActive in eval context)
- Index structures for faster lookups
- Throttling/batching at the call site

Pick whatever approach produces the cleanest code that passes the benchmarks. Refactor freely — no backwards compatibility needed.

## Progress Report Format

APPEND to perf-progress.txt (never replace, always append):
```
## [Date/Time] - [Property ID]
- What was implemented/optimized
- Files changed
- Benchmark results (before/after numbers)
- **Learnings for future iterations:**
  - Patterns discovered
  - What worked / what didn't
---
```

## Consolidate Patterns

If you discover a **reusable pattern**, add it to the `## Codebase Patterns` section at the TOP of perf-progress.txt.

## Commit Format

Commits must tell the full story. Use this format:

```
perf: [Property ID] - [Property Name]

## What changed
- Bullet list of concrete code changes (files, functions, structures modified)

## Why
- Brief explanation of the bottleneck or problem addressed

## Benchmark results
- Include before/after numbers from the benchmarks
- Use actual measured values, not estimates
- Format: metric: before -> after (e.g., "reduceEvent @5000 events: 1.2ms/event -> 0.05ms/event")

## Approach
- Brief description of the optimization strategy chosen and why
```

Pass the commit message via heredoc:
```bash
git commit -m "$(cat <<'EOF'
perf: P1 - Sublinear degradation

## What changed
- ...

## Benchmark results
- ...
EOF
)"
```

## Quality Requirements

- ALL existing tests must pass after changes: `bun test packages/ai/client/hypergraph/`
- Run `bun run format` before committing
- Keep changes focused per property
- Follow existing code patterns

## Stop Condition

After completing a property, check if ALL properties have `passes: true`.

If ALL properties are complete and passing, reply with:
<promise>COMPLETE</promise>

If there are still properties with `passes: false`, end your response normally (another iteration will pick up the next property).

## Important

- Work on ONE property per iteration
- Commit frequently
- Keep tests green
- Read the Codebase Patterns section in perf-progress.txt before starting
- Benchmarks ARE the verification — if the benchmark passes, the property holds
