# Max Iterations Graceful Exit

## Problem

When the agent loop exhausts `maxIterations` and the final iteration ended with tool calls, the loop silently exits. The model's tool calls execute, results are appended to `messages`, but the loop condition fails and no further LLM call is made. The model never sees its tool results and the user sees no final response.

## Design

Extend the existing `while` loop by one extra iteration instead of duplicating the event-handling code after the loop. On this extra iteration:

1. **No tools** — forces the model to produce a text response
2. **A synthetic system message** appended to `messages` — tells the model this is its last turn and it should summarize

Because `messages` is a local mutable array in the agent loop, the synthetic message never leaks to the caller. The existing event handling, tool-call collection, and exit logic (`if (toolCalls.length === 0)`) all work as-is — no code duplication.

### Conditions for the final call

The extra iteration runs **only** when both are true:

- The `while` loop ran all `maxIterations` iterations (natural exit, not early return)
- The last iteration contained tool calls (the model was still working)

If the model finishes naturally before `maxIterations` (returns no tool calls on any iteration), the existing early return at line 87-89 handles it — no change needed.

### Implementation

In `packages/ai/harness/agent.ts`:

1. Add `let lastHadToolCalls = false` before the loop
2. Set `lastHadToolCalls = true` at the end of each iteration that processes tool calls
3. Extend the loop bound by 1 and gate the extra iteration:

```typescript
let lastHadToolCalls = false;

while (iterations++ < maxIterations + 1) {
  const isSummarizing = iterations > maxIterations;

  if (isSummarizing && !lastHadToolCalls) break;

  if (isSummarizing) {
    messages.push({
      role: "system",
      content:
        "You have reached the maximum number of tool call iterations. " +
        "Summarize your progress and provide your final response.",
    });
  }

  const toolCalls: ToolCall[] = [];
  assistantText = "";

  for await (const event of harness.invoke({
    ...params,
    messages,
    tools: isSummarizing ? [] : params.tools,
    context: { parentId: myRunId },
  })) {
    // ... existing event handling (text, reasoning, usage, error, tool_call)
  }

  if (toolCalls.length === 0) {
    // ... existing exit logic
  }

  // ... existing tool execution logic

  lastHadToolCalls = toolCalls.length > 0;
}
```

The only changes to the existing loop body are:
- `harness.invoke` receives `tools: isSummarizing ? [] : params.tools` instead of `params.tools`
- `lastHadToolCalls` is set at the end of each iteration

Everything else (event handling, permission checks, tool execution) remains identical and naturally handles the summarization iteration — since no tools are offered, `toolCalls` will be empty, and the existing `if (toolCalls.length === 0)` exit path returns the summarized text.

### What changes

| File | Change |
|------|--------|
| `packages/ai/harness/agent.ts` | Add `lastHadToolCalls` flag, `isSummarizing` guard, conditional tools |

### What doesn't change

- `maxIterations` default (10)
- Early return behavior (model finishes before budget)
- Tool execution logic
- Message format for callers
- Provider harness
- Orchestrator / multiplexer
