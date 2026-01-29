# Subagents Design

## Overview

Subagents are agent harness invocations spawned by a tool call. They are first-class citizens — their events stream to the client in parallel with other agents, they can use tools, and they can spawn their own subagents. No new primitives, event types, or graph concepts are introduced.

## Core Model

A single `agent` tool is registered with the parent. The LLM calls it with `{ task: string }`. The tool's `execute` function calls `ctx.spawn(task)`, which is provided by the orchestrator via `ToolContext`. The subagent runs a full harness loop and its events stream to the client through the multiplexer. When the subagent completes, `spawn` resolves with the final assistant text, which the tool returns as its result.

## Graph

The subagent's `runId` is its own unique ID. Its `parentId` is the `toolCallId` from the parent's tool call. The graph stays pure `id`/`parentId`:

```
agent-run-1
  ├─ text "I'll search and analyze..."
  ├─ tool_call "tc-1" (agent: search)
  │   └─ agent-run-2 (parentId: "tc-1")
  │       ├─ text, tool_calls, tool_results...
  │       └─ text "Found X, Y, Z"
  ├─ tool_call "tc-2" (agent: analyze)
  │   └─ agent-run-3 (parentId: "tc-2")
  │       ├─ text, tool_calls, tool_results...
  │       └─ text "Analysis shows..."
  └─ text "Based on the search and analysis..."
```

Arbitrary nesting depth is supported naturally.

## Changes

### Agent Harness

1. **Return final text.** The async generator `return`s the final assistant text content instead of just completing. The orchestrator reads this via `.next()` iteration — when `done` is `true`, `value` is the result.

2. **Concurrent tool dispatch.** Tool calls within a single LLM response are dispatched concurrently via `Promise.all` instead of sequentially. This benefits all tools, not just subagent spawns.

### Orchestrator

Add a `spawn(task)` method that:

1. Creates a new agent harness with inherited config (model, tools, system prompt, max iterations)
2. Registers it with the multiplexer (events stream to client)
3. Iterates the generator with `.next()`, forwarding events to the multiplexer
4. When the generator completes (`done: true`), returns `next.value` — the final assistant text

Inject `spawn` into `ToolContext` so any tool can call it.

### Tool Definition

```typescript
{
  name: "agent",
  description: "Spawn a subagent to handle a task",
  schema: z.object({ task: z.string() }),
  execute: async ({ task }, ctx) => {
    const result = await ctx.spawn(task);
    return { context: result };
  }
}
```

A regular tool. No special-casing in the harness.

### Client / Graph / Selectors / Events

No changes. Subagent events arrive tagged with their own `agentId`, the graph reducer processes them like any other agent, and selectors work unchanged.

## Parallel Streaming

When the parent LLM returns multiple tool calls in one response (e.g., two `agent` calls), the harness dispatches them concurrently. Each `ctx.spawn(task)` call runs independently — the orchestrator registers each subagent with the multiplexer, and they stream in parallel. The harness awaits all results via `Promise.all` before continuing the parent's agentic loop.

The multiplexer already handles concurrent agents via `Promise.race`, so no new concurrency primitives are needed.

## Permissions

Subagents inherit the parent's permissions config. Permission relays from subagents flow through the existing relay mechanism unchanged.

## Lifecycle

- **Cancellation:** Aborting the SSE connection tears down the orchestrator, multiplexer, and all agents (parents and subagents).
- **Iteration limits:** Each subagent has its own counter, independent of the parent.
- **Errors:** If a subagent throws, `spawn` rejects, the tool's `execute` throws, and the harness handles it like any tool execution failure.
