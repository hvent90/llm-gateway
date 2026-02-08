# Client-Side Tool Progress

## Problem

The harness emits `tool_progress` events during tool execution (e.g., exec streaming stdout/stderr and process metrics), but the client has no handling for them. The event type exists in `HarnessEvent` but is absent from the server wire format, client graph, projections, and UI.

Different tools emit different progress shapes. For exec, stdout/stderr should be appended into a scrolling buffer while metrics should only keep the latest snapshot. This interpretation logic must be shared across web and CLI clients — only the final rendering differs.

## Design

### Layer 1: Plumbing

Add `tool_progress` to the existing event pipeline. No tool-specific knowledge — just storage and transport.

- **Server event** (`packages/ai/client/server-event.ts`): Add `tool_progress` to `ServerEvent` union with `toolCallId`, `name`, `content`.
- **Server serialization** (`server/index.ts`): Add case in `serializeEvent()` to emit `tool_progress` over SSE.
- **Graph node** (`packages/ai/client/types.ts`): Add `tool_progress` node kind with `toolCallId`, `name`, `content: unknown`.
- **Graph reducer** (`packages/ai/client/graph.ts`): Handle `tool_progress` — insert node, wire edges via `toolCallId`.

### Layer 2: Tool Progress Accumulators

Pure reducers co-located with tool implementations. Each tool defines how to interpret its own progress events.

**Interface** (in `packages/ai/client/`):

```ts
interface ToolProgressAccumulator<TState> {
  init(): TState;
  reduce(state: TState, content: unknown): TState;
}
```

**Exec accumulator** (in `packages/ai/rlm/exec-progress.ts`):

```ts
type ExecProgressState = {
  stdout: string;
  stderr: string;
  metrics: {
    pid: number;
    cpuPercent: number;
    rssKb: number;
    wallMs: number;
  } | null;
};
```

- `{ channel, data }` → append to `stdout` or `stderr` buffer
- `{ pid, cpuPercent, rssKb, wallMs }` → replace `metrics` with latest

**Manifest** — a single file that imports all accumulators and exports the lookup map. New tools add a line here.

```ts
import { execAccumulator } from "../rlm/exec-progress";

export const toolProgressAccumulators: Record<string, ToolProgressAccumulator<unknown>> = {
  exec: execAccumulator,
};
```

A helper `accumulate(name, events)` folds events through the right accumulator. Returns `null` if no accumulator registered.

### Layer 3: Thread Projection

The thread projection already merges `tool_result` into `tool_call` ViewNodes. Same pattern for progress:

1. Collect `tool_progress` nodes for a `toolCallId`
2. Look up accumulator by tool `name`
3. Fold events → attach resulting state as `progress` field on the tool_call `ViewContent`

`progress` typed as `unknown` at the projection level. UI narrows by tool name.

### Layer 4: UI

Thin rendering only. No reduction logic.

**Web**: `ToolCallView` checks `progress`, renders tool-specific component based on `name`. For exec: scrollable stdout/stderr block + metrics line (CPU/RSS/wall time).

**CLI**: Same data, compact presentation.

Both import the accumulator's state type for type narrowing. No other dependency on tool code.

## Key Decisions

- **Accumulators co-located with tools** — the tool author owns both the emit shape and the interpretation.
- **Central manifest for registry** — explicit, greppable, no side-effect imports.
- **Projection attaches progress but doesn't interpret it** — UI narrows types per tool.
- **Status (running/complete) stays in projection** — accumulators only handle progress state.
