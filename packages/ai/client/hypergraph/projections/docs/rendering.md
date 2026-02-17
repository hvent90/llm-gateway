# Projection Rendering Details

## Thread Projection

`projectThread(graph)` (see `thread.ts`) walks the hypergraph and produces a flat `ViewNode[]` for chat UI rendering.

Each ViewNode has:

```typescript
{
  id: string;
  runId: string;
  role: "user" | "assistant";
  content: ViewContent;  // text, reasoning, tool_call, user, error, relay, pending
  status: "streaming" | "complete" | "error";
  branches: ViewNode[][];  // Nested subagent runs
}
```

Key behaviors:

- **Tool result attachment** — `tool_result` chunks retroactively attach their output to the matching `tool_call` ViewNode (backward scan) rather than creating separate entries.
- **Tool progress accumulation** — `tool_progress` chunks accumulate into the matching `tool_call` ViewNode's `progress` field via `accumulate()` from `progress.ts`.
- **Subagent branches** — spawn edges produce nested `branches` arrays on the tool_call that triggered them.
- **Promotion logic** — when a chunk has no same-run continuation but has cross-run spawn targets, the first target is "promoted" from a branch to a continuation (inlined into the flat list) — unless the chunk is a `tool_call`, which always keeps spawns as branches.
- **Pending placeholder** — a `harness_start` with no continuation yet (subagent just spawned, no content) emits a `{ kind: "pending" }` ViewNode so the branch isn't discarded while streaming.

## Messages Projection

`projectMessages(graph)` (see `messages.ts`) transforms the hypergraph into LLM API `Message[]` format for building follow-up requests. Builds on `projectThread` — walks the flat `ViewNode[]` output (branches excluded) rather than traversing the graph directly. Excludes reasoning, error, relay, and pending nodes.

## DAG Projection

`projectDAG(graph)` (see `dag.ts`) produces `DAGLayout` for SVG graph visualization with deterministic layout (no physics simulation):

- **DAGNode[]** — one per block node. Block type derived from chunk content (text, reasoning, tool_call, tool_result, user, error, structural). Label extracted via `deriveBlockContent`. Each node has deterministic `x, y, width, height`.
- **DAGEdge[]** — block-to-block sequence edges + spawn edges. Cross-message sequences resolved from last-block → first-block.
- **DAGGroup[]** — message groups and summary groups as bounding boxes around their constituent nodes. Sorted: message groups first, summary groups on top.
