# Projections

Transform a `ConversationGraph` into view-specific formats. Each projection walks the graph differently depending on what the consumer needs.

## Files

- `thread.ts` — `projectThread(graph) → ViewNode[]` for chat UI. Walks at chunk level, merges consecutive text/reasoning, nests subagent branches.
- `messages.ts` — `projectMessages(graph) → Message[]` for LLM API follow-up requests. Builds on `projectThread`, not the graph directly.
- `dag.ts` — `projectDAG(graph) → DAGLayout` for SVG DAG visualization. Computes deterministic top-down layout with block nodes, sequence/spawn edges, message groups, and summary groups.

## Gotchas

- `thread.ts` retroactively mutates `tool_call` ViewNodes when `tool_result`/`tool_progress` chunks arrive later (backward scan in `walkRun`)
- `thread.ts` promotion logic: when a chunk has no same-run successor but has spawn targets, the first target is promoted from branch to continuation — unless the chunk is a `tool_call`, which always keeps spawns as branches
- `thread.ts` emits `{ kind: "pending" }` for `harness_start` with no content yet, so streaming subagent branches aren't discarded
- `messages.ts` excludes branches — only the flat top-level ViewNode list is converted to messages
- `dag.ts` resolves cross-message links by connecting last-block → first-block of adjacent messages
- `dag.ts` lays out spawn branches in separate columns with `COLUMN_GAP` spacing
