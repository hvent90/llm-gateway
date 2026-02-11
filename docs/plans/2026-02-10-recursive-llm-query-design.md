# Recursive llm_query

Make `llm_query` actually recursive. When the model calls `llm_query(prompt)`, it spawns a full RLM session — own REPL, scope, iteration loop, exec — instead of a flat one-shot LLM call. Drop `sub_rlm` entirely.

## Interface Changes

- Add `maxDepth?: number` to `RlmConfig`. Default: `2`.
- At depth 0, `llm_query` falls back to a flat one-shot call (current behavior). This is the base case.
- `llm_query` signature stays `(prompt: string) => Promise<string>`. The model doesn't know or care whether it's recursive.
- Remove `sub_rlm` completely: type, builtin, prompt references, tests.

## How It Works

The parent model calls `llm_query("Summarize this:\n" + chunk)`. The prompt string becomes the child's `context`. The child RLM gets:

```ts
childRlm.invoke({
  model: ...,
  context: prompt,
  messages: [{ role: "user", content: "Process the context and return a result." }],
})
```

The child iterates its own REPL, can call its own `llm_query` (which recurses further or falls back to flat at depth 0), and returns its final answer as the string result.

## Event Forwarding

Child RLM events (tool_call, tool_result, tool_progress, text, usage) bubble up through the parent's `execEvents` queue as `{ type: "progress", event }`. The parent's drain loop yields them. Child events carry their own `runId`; the parent tags them with `parentId` linking to the parent's run. The client renders the recursion tree via the existing graph structure.

## Depth Limiting

`maxDepth` in `RlmConfig`. Each recursive `llm_query` decrements it. At depth 0, `llm_query` is a flat `subHarness.invoke()` call — exactly what exists today. Children inherit the parent's `RlmConfig` with `maxDepth` decremented.

## File Changes

**`types.ts`:**
- Add `maxDepth?: number` to `RlmConfig`
- Remove `SubRlmFn` type

**`repl.ts`:**
- Remove `subRlm` from `ReplOptions`
- Remove `sub_rlm` from builtins and scope setup

**`harness.ts`:**
- `llm_query` checks depth:
  - depth > 0: create child `createRlmHarness` with `maxDepth: depth - 1`, invoke, forward events, return final text
  - depth === 0: flat one-shot call (current behavior)
- Remove `subRlm: llmQuery` from `createRepl()` call

**`system-prompt.ts`:**
- Remove `sub_rlm` from Available Functions and Rules
- Update `llm_query` description to reflect its recursive capability

**Tests:**
- Remove `sub_rlm` REPL tests
- Add harness test: deterministic provider simulating recursive `llm_query` that spawns child RLM
- Existing integration test should still pass

## What We're NOT Doing

- No shared iteration budget — each child gets its own `maxIterations`
- No prompt/context splitting — the prompt string IS the child's context
- No changes to exec — children get exec too (same permissions, same relay flow)
- No client changes — existing runId/parentId graph handles nesting
