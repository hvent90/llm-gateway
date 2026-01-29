# Subagents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable subagent spawning via a tool call, with parallel streaming and full agent capabilities.

**Architecture:** The `agent` tool calls `ctx.spawn(task)` provided by the orchestrator via `ToolContext`. The orchestrator creates a new agent harness invocation, feeds its events into the multiplexer via a passthrough async iterable, iterates with `.next()` to capture the return value, and resolves with the final assistant text. Tool calls within a single LLM response are dispatched concurrently via `Promise.all`.

**Tech Stack:** Bun, TypeScript, Zod, deterministic harness for testing

---

### Task 1: Agent harness returns final assistant text

The agent harness async generator currently returns `void`. Change it to `return` the accumulated assistant text from the final iteration so callers can read it via `iterator.next()` when `done` is `true`.

**Files:**
- Modify: `packages/ai/harness/agent.ts`
- Test: `packages/ai/harness/__tests__/agent.test.ts`

**Step 1: Write the failing test**

Add to `packages/ai/harness/__tests__/agent.test.ts`:

```typescript
test("returns final assistant text as generator return value", async () => {
  const mockHarness: GeneratorHarnessModule = {
    async *invoke() {
      yield { type: "text", runId: "r1", id: "t1", content: "Hello " };
      yield { type: "text", runId: "r1", id: "t2", content: "world" };
    },
    async supportedModels() {
      return ["test-model"];
    },
  };

  const agentHarness = createAgentHarness({ harness: mockHarness });

  const stream = agentHarness.invoke({
    model: "test-model",
    messages: [{ role: "user", content: "Hi" }],
  });

  const iterator = stream[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done) {
    next = await iterator.next();
  }

  expect(next.value).toBe("Hello world");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts -t "returns final assistant text"`
Expected: FAIL — `next.value` is `undefined`

**Step 3: Write minimal implementation**

In `packages/ai/harness/agent.ts`:

1. Move `assistantText` declaration above the `while` loop (after `let iterations = 0;`): `let assistantText = "";`
2. At the top of the while loop body, reset it: `assistantText = "";` (replacing the existing `let assistantText = "";`)
3. Change line 81 (`return;`) to: `return assistantText;`
4. After the while loop's closing brace, add: `return assistantText;`

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts -t "returns final assistant text"`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/harness/agent.ts packages/ai/harness/__tests__/agent.test.ts
git commit -m "feat(agent): return final assistant text as generator return value"
```

---

### Task 2: Add `spawn` to ToolContext and GeneratorInvokeParams

Extend `ToolContext` and `GeneratorInvokeParams.context` with an optional `spawn` function.

**Files:**
- Modify: `packages/ai/types.ts`

**Step 1: Modify types**

In `packages/ai/types.ts`, add `spawn` to `ToolContext`:

```typescript
export interface ToolContext {
  parentId?: string;
  spawn?: (task: string) => Promise<string>;
}
```

And to the `context` field in `GeneratorInvokeParams`:

```typescript
export interface GeneratorInvokeParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  context?: {
    parentId?: string;
    spawn?: (task: string) => Promise<string>;
  };
  permissions?: Permissions;
}
```

**Step 2: Run type check**

Run: `bun run check`
Expected: PASS (additive change)

**Step 3: Commit**

```bash
git add packages/ai/types.ts
git commit -m "feat(types): add spawn to ToolContext and GeneratorInvokeParams"
```

---

### Task 3: Agent harness passes `spawn` through to ToolContext

The agent harness constructs `ToolContext` at line 155-157 with only `parentId`. It needs to also pass through `spawn` from `params.context`.

**Files:**
- Modify: `packages/ai/harness/agent.ts:155-157`
- Test: `packages/ai/harness/__tests__/agent.test.ts`

**Step 1: Write the failing test**

Add to `packages/ai/harness/__tests__/agent.test.ts`:

```typescript
test("passes spawn from context through to tool execute", async () => {
  let receivedSpawn: unknown;

  const toolSchema = z.object({ value: z.string() });
  const captureTool: ToolDefinition<typeof toolSchema, string> = {
    name: "capture",
    description: "Captures context. Always use this tool.",
    schema: toolSchema,
    execute: async (_input, ctx) => {
      receivedSpawn = ctx.spawn;
      return { context: "captured", result: "ok" };
    },
  };

  // Provider that emits a tool call
  const mockHarness: GeneratorHarnessModule = {
    async *invoke(params) {
      const hasToolResult = params.messages.some((m) => m.role === "tool");
      if (hasToolResult) {
        yield { type: "text", runId: "r1", id: "t2", content: "Done" };
      } else {
        yield {
          type: "tool_call",
          runId: "r1",
          id: "tc-1",
          name: "capture",
          input: { value: "test" },
        };
      }
    },
    async supportedModels() {
      return ["test-model"];
    },
  };

  const spawnFn = async (task: string) => task;

  const agentHarness = createAgentHarness({ harness: mockHarness });
  const events: HarnessEvent[] = [];
  for await (const event of agentHarness.invoke({
    model: "test-model",
    messages: [{ role: "user", content: "Use capture tool" }],
    tools: [captureTool],
    permissions: { allowlist: [{ tool: "capture" }] },
    context: { spawn: spawnFn },
  })) {
    events.push(event);
  }

  expect(receivedSpawn).toBe(spawnFn);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts -t "passes spawn from context"`
Expected: FAIL — `receivedSpawn` is `undefined`

**Step 3: Write minimal implementation**

In `packages/ai/harness/agent.ts`, change lines 155-157:

From:
```typescript
const toolCtx: ToolContext = {
  parentId: tc.id,
};
```

To:
```typescript
const toolCtx: ToolContext = {
  parentId: tc.id,
  spawn: params.context?.spawn,
};
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts -t "passes spawn from context"`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/harness/agent.ts packages/ai/harness/__tests__/agent.test.ts
git commit -m "feat(agent): pass spawn through to ToolContext"
```

---

### Task 4: Concurrent tool dispatch in agent harness

Change the agent harness to dispatch tool calls concurrently via `Promise.all` instead of the sequential `for` loop.

**Files:**
- Modify: `packages/ai/harness/agent.ts:91-184`
- Test: `packages/ai/harness/__tests__/agent.test.ts`

**Step 1: Write the failing test**

Add to `packages/ai/harness/__tests__/agent.test.ts`:

```typescript
test("dispatches multiple tool calls concurrently", async () => {
  const callOrder: string[] = [];
  const slowSchema = z.object({ id: z.string() });

  const slowTool: ToolDefinition<typeof slowSchema, string> = {
    name: "slow",
    description: "A slow tool",
    schema: slowSchema,
    execute: async ({ id }) => {
      callOrder.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push(`end-${id}`);
      return { context: `done-${id}`, result: id };
    },
  };

  // Provider that emits two tool calls in one response
  const mockHarness: GeneratorHarnessModule = {
    async *invoke(params) {
      const hasToolResult = params.messages.some((m) => m.role === "tool");
      if (hasToolResult) {
        yield { type: "text", runId: "r1", id: "t1", content: "All done" };
      } else {
        yield { type: "tool_call", runId: "r1", id: "tc-1", name: "slow", input: { id: "a" } };
        yield { type: "tool_call", runId: "r1", id: "tc-2", name: "slow", input: { id: "b" } };
      }
    },
    async supportedModels() {
      return ["test-model"];
    },
  };

  const agentHarness = createAgentHarness({ harness: mockHarness });

  for await (const _ of agentHarness.invoke({
    model: "test-model",
    messages: [{ role: "user", content: "Run both" }],
    tools: [slowTool],
    permissions: { allowlist: [{ tool: "slow" }] },
  })) {
    // drain
  }

  // If concurrent: start-a, start-b, end-a, end-b (or end-b, end-a)
  // If sequential: start-a, end-a, start-b, end-b
  // Concurrent means both starts happen before any end
  expect(callOrder[0]).toBe("start-a");
  expect(callOrder[1]).toBe("start-b");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts -t "dispatches multiple tool calls concurrently"`
Expected: FAIL — sequential order: `start-a, end-a, start-b, end-b`

**Step 3: Write minimal implementation**

Replace the sequential `for (const tc of toolCalls)` loop (lines 91-184) with concurrent dispatch. The key change: build an array of promises for each tool call's processing, then `await Promise.all(...)`.

Each tool call's processing still needs to yield events (tool_call, tool_result, relay). Since we're inside an async generator and can't yield from inside a `Promise.all` callback, we need to collect events and yield them after all tools complete. But that changes the streaming behavior — events would be batched rather than streamed as they happen.

Alternative approach: separate the tool processing into two phases:
1. **Permission check phase** — can stay sequential or be batched (permissions for all tools checked up front)
2. **Execution phase** — all approved tools execute concurrently

But yielding events during concurrent execution is the real challenge. We can collect the events and results per tool call, then yield them all after `Promise.all` resolves:

```typescript
// Process all tool calls concurrently
const toolPromises = toolCalls.map(async (tc) => {
  const toolDef = params.tools?.find((t) => t.name === tc.name);
  const args = (tc.arguments ?? {}) as Record<string, unknown>;
  const events: HarnessEvent[] = [];

  // Check deny list
  const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
  if (denial) {
    const output = { status: "denied", reason: denial.reason };
    events.push(tag({ type: "tool_result", runId: myRunId, id: tc.id, name: tc.name, output }));
    return { tc, events, toolMessage: { role: "tool" as const, tool_call_id: tc.id, content: JSON.stringify(output) } };
  }

  // Check permissions
  const isAllowed = params.permissions && matchesPermissions({ name: tc.name, arguments: args }, params.permissions);

  if (!isAllowed) {
    const { promise, resolve } = deferred<PermissionResponse>();
    events.push(tag({
      type: "relay",
      kind: "permission" as const,
      runId: myRunId,
      id: uuidv7(),
      toolCallId: tc.id,
      tool: tc.name,
      params: args,
      respond: (response: PermissionResponse) => resolve(response),
    }));

    // Can't pause here in a Promise — relay events need to be yielded
    // This approach doesn't work for relays
  }
  // ...
});
```

The relay/permission pattern doesn't work inside `Promise.all` because the generator needs to yield the relay event and pause. We can't yield from inside a promise callback.

**Revised approach:** Keep permissions sequential (yield relay, await response), then execute all approved tools concurrently. Split into two passes:

Pass 1 (sequential): For each tool call, check permissions. If relay needed, yield it and await. Collect the set of approved/denied tool calls.

Pass 2 (concurrent): Execute all approved tool calls concurrently with `Promise.all`. Yield all events after.

```typescript
// Pass 1: permissions (sequential, must yield relays)
const approved: Array<{ tc: ToolCall; toolDef: ToolDefinition }> = [];
for (const tc of toolCalls) {
  const toolDef = params.tools?.find((t) => t.name === tc.name);
  const args = (tc.arguments ?? {}) as Record<string, unknown>;

  // Check deny list
  const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
  if (denial) {
    const output = { status: "denied", reason: denial.reason };
    yield tag({ type: "tool_result", runId: myRunId, id: tc.id, name: tc.name, output });
    messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
    continue;
  }

  // Check permissions
  const isAllowed = params.permissions && matchesPermissions({ name: tc.name, arguments: args }, params.permissions);
  if (!isAllowed) {
    const { promise, resolve } = deferred<PermissionResponse>();
    yield tag({ type: "relay", kind: "permission", runId: myRunId, id: uuidv7(), toolCallId: tc.id, tool: tc.name, params: args, respond: (response: PermissionResponse) => resolve(response) });
    const decision = await promise;
    if (!decision.approved) {
      const output = { status: "denied", reason: decision.reason };
      yield tag({ type: "tool_result", runId: myRunId, id: tc.id, name: tc.name, output });
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
      continue;
    }
  }

  yield tag({ type: "tool_call", runId: myRunId, name: tc.name, id: tc.id, input: args });

  if (!toolDef?.execute) {
    yield tag({ type: "error", runId: myRunId, error: new Error(`No executor for tool: ${tc.name}`) });
    return assistantText;
  }

  approved.push({ tc, toolDef });
}

// Pass 2: execute approved tools concurrently
const results = await Promise.all(
  approved.map(async ({ tc, toolDef }) => {
    const toolCtx: ToolContext = { parentId: tc.id, spawn: params.context?.spawn };
    try {
      const { context: toolContext, result: toolResult } = await toolDef.execute!(tc.arguments, toolCtx);
      const output = { context: toolContext, result: toolResult };
      return {
        event: tag({ type: "tool_result" as const, runId: myRunId, name: tc.name, id: tc.id, output }),
        message: { role: "tool" as const, tool_call_id: tc.id, content: toolContext ?? JSON.stringify(output) },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        event: tag({ type: "error" as const, runId: myRunId, error: error instanceof Error ? error : new Error(errorMsg) }),
        message: { role: "tool" as const, tool_call_id: tc.id, content: JSON.stringify({ error: errorMsg }) },
      };
    }
  }),
);

// Yield results and add to messages
for (const { event, message } of results) {
  yield event;
  messages.push(message);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts -t "dispatches multiple tool calls concurrently"`
Expected: PASS

**Step 5: Run all agent harness tests**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts`
Expected: All existing tests still pass

**Step 6: Commit**

```bash
git add packages/ai/harness/agent.ts packages/ai/harness/__tests__/agent.test.ts
git commit -m "feat(agent): dispatch tool calls concurrently with Promise.all"
```

---

### Task 5: Passthrough async iterable primitive

Create a `Passthrough` primitive — an async iterable backed by a push/end interface. The orchestrator will use this to feed subagent events into the multiplexer while iterating the subagent's generator directly.

**Files:**
- Create: `packages/ai/primitives/passthrough.ts`
- Modify: `packages/ai/primitives/index.ts`
- Test: `packages/ai/primitives/__tests__/passthrough.test.ts`

**Step 1: Write the failing test**

Create `packages/ai/primitives/__tests__/passthrough.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { createPassthrough } from "../passthrough";

describe("Passthrough", () => {
  test("yields pushed values", async () => {
    const pt = createPassthrough<number>();
    pt.push(1);
    pt.push(2);
    pt.end();

    const values: number[] = [];
    for await (const v of pt.iterable) {
      values.push(v);
    }

    expect(values).toEqual([1, 2]);
  });

  test("waits for push when buffer is empty", async () => {
    const pt = createPassthrough<string>();

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const v of pt.iterable) {
        collected.push(v);
      }
    })();

    pt.push("a");
    pt.push("b");
    pt.end();

    await consumer;
    expect(collected).toEqual(["a", "b"]);
  });

  test("completes iteration on end()", async () => {
    const pt = createPassthrough<number>();
    pt.end();

    const values: number[] = [];
    for await (const v of pt.iterable) {
      values.push(v);
    }

    expect(values).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/primitives/__tests__/passthrough.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `packages/ai/primitives/passthrough.ts`:

```typescript
interface Passthrough<T> {
  push(value: T): void;
  end(): void;
  iterable: AsyncIterable<T>;
}

export function createPassthrough<T>(): Passthrough<T> {
  const buffer: T[] = [];
  let resolve: ((value: IteratorResult<T>) => void) | null = null;
  let done = false;

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) {
            return Promise.resolve({ done: false, value: buffer.shift()! });
          }
          if (done) {
            return Promise.resolve({ done: true, value: undefined as unknown as T });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };

  return {
    push(value: T) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ done: false, value });
      } else {
        buffer.push(value);
      }
    },
    end() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ done: true, value: undefined as unknown as T });
      }
    },
    iterable,
  };
}
```

**Step 4: Update index.ts**

Add to `packages/ai/primitives/index.ts`:

```typescript
export { createPassthrough } from "./passthrough";
```

**Step 5: Run test to verify it passes**

Run: `bun test packages/ai/primitives/__tests__/passthrough.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/ai/primitives/passthrough.ts packages/ai/primitives/__tests__/passthrough.test.ts packages/ai/primitives/index.ts
git commit -m "feat(primitives): add Passthrough async iterable"
```

---

### Task 6: Orchestrator `spawnSubagent` method

Add `spawnSubagent` to the orchestrator. It creates a new harness invocation, feeds events into the multiplexer via a passthrough, iterates with `.next()`, and returns the final assistant text.

**Files:**
- Modify: `packages/ai/orchestrator.ts`
- Test: `packages/ai/__tests__/orchestrator.test.ts`

**Step 1: Write the failing test**

Add to `packages/ai/__tests__/orchestrator.test.ts`:

```typescript
import { createDeterministicHarness } from "../harness/providers/deterministic";
import { createAgentHarness } from "../harness/agent";

describe("spawnSubagent", () => {
  test("subagent events stream through multiplexer and spawn resolves with final text", async () => {
    // Deterministic provider: response 0 for parent (tool call), response 1 for subagent (text), response 2 for parent (final text)
    const provider = createDeterministicHarness({
      responses: [
        { events: [{ type: "tool_call", name: "agent", input: { task: "say hello" } }] },
        { events: [{ type: "text", content: "Hello from subagent" }] },
        { events: [{ type: "text", content: "Subagent said hello" }] },
      ],
    });

    const agentTool: ToolDefinition<z.ZodObject<{ task: z.ZodString }>, string> = {
      name: "agent",
      description: "Spawn a subagent",
      schema: z.object({ task: z.string() }),
      execute: async ({ task }, ctx) => {
        const result = await ctx.spawn!(task);
        return { context: result, result };
      },
    };

    const harness = createAgentHarness({ harness: provider });
    const orchestrator = new AgentOrchestrator(harness);

    const agentId = orchestrator.spawn({
      model: "deterministic",
      messages: [{ role: "user", content: "Spawn a subagent to say hello" }],
      tools: [agentTool],
      permissions: { allowlist: [{ tool: "agent" }] },
    });

    const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
    for await (const event of orchestrator.events()) {
      events.push(event);
    }

    // Should have events from both parent and subagent
    const agentIds = new Set(events.map((e) => e.agentId));
    expect(agentIds.size).toBe(2);

    // Subagent should have produced text events
    const subagentId = [...agentIds].find((id) => id !== agentId)!;
    const subagentTextEvents = events.filter(
      (e) => e.agentId === subagentId && e.event.type === "text",
    );
    expect(subagentTextEvents.length).toBeGreaterThan(0);

    // Parent should have final text after subagent completed
    const parentTextEvents = events.filter(
      (e) => e.agentId === agentId && e.event.type === "text",
    );
    expect(parentTextEvents.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/__tests__/orchestrator.test.ts -t "subagent events stream"`
Expected: FAIL — `ctx.spawn` is undefined (orchestrator doesn't inject it yet)

**Step 3: Write minimal implementation**

In `packages/ai/orchestrator.ts`:

1. Import `createPassthrough` from primitives
2. Add a `spawnSubagent` method:

```typescript
private async spawnSubagent(
  task: string,
  parentParams: GeneratorInvokeParams,
): Promise<string> {
  const agentId = v7();
  const passthrough = createPassthrough<HarnessEvent>();

  // Register passthrough with multiplexer so events stream to client
  this.mux.register(agentId, passthrough.iterable);

  const stream = this.harness.invoke({
    model: parentParams.model,
    messages: [{ role: "user", content: task }],
    tools: parentParams.tools,
    permissions: parentParams.permissions,
    context: {
      parentId: parentParams.context?.parentId,
      spawn: (t: string) => this.spawnSubagent(t, parentParams),
    },
  });

  // Iterate with .next() to capture return value
  const iterator = stream[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done) {
    passthrough.push(next.value);
    next = await iterator.next();
  }
  passthrough.end();

  return next.value as string; // The final assistant text
}
```

3. Modify `spawn()` to inject the `spawn` function into context:

```typescript
spawn(params: GeneratorInvokeParams): string {
  const agentId = v7();
  const stream = this.harness.invoke({
    ...params,
    context: {
      ...params.context,
      spawn: (task: string) => this.spawnSubagent(task, params),
    },
  });
  this.mux.register(agentId, stream);
  return agentId;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/__tests__/orchestrator.test.ts -t "subagent events stream"`
Expected: PASS

**Step 5: Run all orchestrator tests**

Run: `bun test packages/ai/__tests__/orchestrator.test.ts`
Expected: All non-integration tests pass (integration tests that need OPENROUTER_API_KEY will still fail without the key)

**Step 6: Commit**

```bash
git add packages/ai/orchestrator.ts packages/ai/__tests__/orchestrator.test.ts
git commit -m "feat(orchestrator): add spawnSubagent with multiplexer integration"
```

---

### Task 7: Create the agent tool

Create the `agent` tool definition — a regular tool that calls `ctx.spawn(task)`.

**Files:**
- Create: `packages/ai/tools/agent.ts`
- Test: `packages/ai/tools/__tests__/agent.test.ts`

**Step 1: Write the failing test**

Create `packages/ai/tools/__tests__/agent.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { agentTool } from "../agent";

describe("Agent Tool", () => {
  test("has correct name and schema", () => {
    expect(agentTool.name).toBe("agent");
    expect(agentTool.schema).toBeDefined();
  });

  test("calls ctx.spawn with task and returns result as context", async () => {
    const spawnFn = async (task: string) => `Result for: ${task}`;

    const result = await agentTool.execute!({ task: "do something" }, {
      parentId: "tc-1",
      spawn: spawnFn,
    });

    expect(result.context).toBe("Result for: do something");
  });

  test("throws if spawn is not provided in context", async () => {
    expect(
      agentTool.execute!({ task: "do something" }, { parentId: "tc-1" }),
    ).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/tools/__tests__/agent.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `packages/ai/tools/agent.ts`:

```typescript
import { z } from "zod";
import type { ToolDefinition } from "../types";

const schema = z.object({
  task: z.string().describe("The task for the subagent to perform"),
});

export const agentTool: ToolDefinition<typeof schema, string> = {
  name: "agent",
  description: "Spawn a subagent to handle a task autonomously. The subagent has access to the same tools and will work independently to complete the task, returning its final response.",
  schema,
  execute: async ({ task }, ctx) => {
    if (!ctx.spawn) {
      throw new Error("spawn not available in tool context");
    }
    const result = await ctx.spawn(task);
    return { context: result, result };
  },
};
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/tools/__tests__/agent.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/tools/agent.ts packages/ai/tools/__tests__/agent.test.ts
git commit -m "feat(tools): add agent tool for subagent spawning"
```

---

### Task 8: Subagent parentId is set to toolCallId

Verify that the subagent's events carry the correct `parentId` — the `toolCallId` from the parent's tool call. This happens because the orchestrator passes `parentId` from the parent's context, but we need to ensure the parent passes the tool call's ID (not the agent's run ID).

Currently in the agent harness (line 155-156), when constructing `ToolContext`, `parentId` is set to `tc.id` (the tool call ID). The orchestrator's `spawnSubagent` passes `parentParams.context?.parentId` as the subagent's `parentId`. But `parentParams` is the **parent agent's** invoke params, and `parentParams.context?.parentId` is the parent agent's own parentId — not the tool call ID.

The fix: `spawnSubagent` needs to receive the tool call ID and pass it as the subagent's `context.parentId`. This means the `spawn` function in the tool context needs to forward the `parentId` (which IS the tool call ID, since the harness sets `toolCtx.parentId = tc.id`).

Update the `spawn` function signature to also accept the parentId, or have the tool context's spawn closure capture it. The cleanest: the harness constructs the spawn closure with the parentId baked in:

In the harness, the spawn function passed to the tool is:
```typescript
spawn: params.context?.spawn
```

But we need spawn to set the subagent's parentId to the tool call ID. The tool has `ctx.parentId` (= tc.id). So the tool can call `ctx.spawn(task)` and the orchestrator's spawn should use the tool call ID as parentId.

Approach: Change the `spawn` function to accept a second argument `parentId`, or have the agent harness wrap the spawn function to inject the parentId.

Cleanest: wrap spawn in the harness to inject parentId:

```typescript
const toolCtx: ToolContext = {
  parentId: tc.id,
  spawn: params.context?.spawn
    ? (task: string) => params.context!.spawn!(task, tc.id)
    : undefined,
};
```

And update the spawn signature to `(task: string, parentId?: string) => Promise<string>`.

Wait — but the tool doesn't need to know about parentId. The harness should handle this transparently.

Simpler: change the type of `spawn` on ToolContext to not take a parentId. Instead, have the harness wrap the orchestrator's spawn to bake in the parentId:

In `ToolContext.spawn`: `(task: string) => Promise<string>` (unchanged)

In the orchestrator's `spawnSubagent`: accept a `parentId` parameter.

In the harness, construct spawn as:
```typescript
spawn: params.context?.spawn
  ? (task: string) => params.context!.spawn!(task)
  : undefined,
```

But the orchestrator's spawn closure (set up in `spawn()` method) doesn't know the tool call ID yet. The tool call ID is only known when the harness processes each tool call.

Solution: the spawn function on `GeneratorInvokeParams.context` takes `(task: string, parentId: string)`. The harness wraps it for the tool:

Update `GeneratorInvokeParams.context.spawn` to `(task: string, parentId: string) => Promise<string>`.

Update `ToolContext.spawn` to stay as `(task: string) => Promise<string>` — the tool doesn't need to know.

The harness wraps:
```typescript
const toolCtx: ToolContext = {
  parentId: tc.id,
  spawn: params.context?.spawn
    ? (task: string) => params.context!.spawn!(task, tc.id)
    : undefined,
};
```

The orchestrator's `spawnSubagent` uses the parentId:
```typescript
private async spawnSubagent(task: string, parentId: string, parentParams: GeneratorInvokeParams): Promise<string> {
  // ...
  const stream = this.harness.invoke({
    // ...
    context: { parentId, spawn: (t, pid) => this.spawnSubagent(t, pid, parentParams) },
  });
}
```

**Files:**
- Modify: `packages/ai/types.ts` (GeneratorInvokeParams.context.spawn signature)
- Modify: `packages/ai/harness/agent.ts` (wrap spawn)
- Modify: `packages/ai/orchestrator.ts` (spawnSubagent accepts parentId)
- Test: `packages/ai/__tests__/orchestrator.test.ts`

**Step 1: Write the failing test**

Add to `packages/ai/__tests__/orchestrator.test.ts` inside the `spawnSubagent` describe:

```typescript
test("subagent events have parentId set to tool call ID", async () => {
  const provider = createDeterministicHarness({
    responses: [
      { events: [{ type: "tool_call", name: "agent", input: { task: "say hello" } }] },
      { events: [{ type: "text", content: "Hello from subagent" }] },
      { events: [{ type: "text", content: "Done" }] },
    ],
  });

  const agentTool: ToolDefinition<z.ZodObject<{ task: z.ZodString }>, string> = {
    name: "agent",
    description: "Spawn a subagent",
    schema: z.object({ task: z.string() }),
    execute: async ({ task }, ctx) => {
      const result = await ctx.spawn!(task);
      return { context: result, result };
    },
  };

  const harness = createAgentHarness({ harness: provider });
  const orchestrator = new AgentOrchestrator(harness);

  const agentId = orchestrator.spawn({
    model: "deterministic",
    messages: [{ role: "user", content: "Spawn subagent" }],
    tools: [agentTool],
    permissions: { allowlist: [{ tool: "agent" }] },
  });

  const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
  for await (const event of orchestrator.events()) {
    events.push(event);
  }

  // Find the parent's tool_call event to get the tool call ID
  const parentToolCall = events.find(
    (e) => e.agentId === agentId && e.event.type === "tool_call" && e.event.name === "agent",
  );
  expect(parentToolCall).toBeDefined();
  const toolCallId = (parentToolCall!.event as { id: string }).id;

  // Find the subagent's text events
  const subagentId = [...new Set(events.map((e) => e.agentId))].find((id) => id !== agentId)!;
  const subagentTextEvents = events.filter(
    (e) => e.agentId === subagentId && e.event.type === "text",
  );

  // Subagent events should have parentId = toolCallId
  for (const e of subagentTextEvents) {
    expect((e.event as { parentId?: string }).parentId).toBe(toolCallId);
  }
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/__tests__/orchestrator.test.ts -t "subagent events have parentId"`
Expected: FAIL — parentId is wrong or undefined

**Step 3: Write minimal implementation**

1. In `packages/ai/types.ts`, update `GeneratorInvokeParams.context.spawn`:
```typescript
context?: {
  parentId?: string;
  spawn?: (task: string, parentId: string) => Promise<string>;
};
```

Keep `ToolContext.spawn` as `(task: string) => Promise<string>` (unchanged — the tool doesn't know about parentId).

2. In `packages/ai/harness/agent.ts`, wrap spawn to inject tc.id:
```typescript
const toolCtx: ToolContext = {
  parentId: tc.id,
  spawn: params.context?.spawn
    ? (task: string) => params.context!.spawn!(task, tc.id)
    : undefined,
};
```

3. In `packages/ai/orchestrator.ts`, update `spawnSubagent` to accept and use parentId:
```typescript
private async spawnSubagent(
  task: string,
  parentId: string,
  parentParams: GeneratorInvokeParams,
): Promise<string> {
  const agentId = v7();
  const passthrough = createPassthrough<HarnessEvent>();
  this.mux.register(agentId, passthrough.iterable);

  const stream = this.harness.invoke({
    model: parentParams.model,
    messages: [{ role: "user", content: task }],
    tools: parentParams.tools,
    permissions: parentParams.permissions,
    context: {
      parentId,
      spawn: (t: string, pid: string) => this.spawnSubagent(t, pid, parentParams),
    },
  });

  const iterator = stream[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done) {
    passthrough.push(next.value);
    next = await iterator.next();
  }
  passthrough.end();

  return next.value as string;
}
```

Update `spawn()` to also pass parentId through:
```typescript
spawn(params: GeneratorInvokeParams): string {
  const agentId = v7();
  const stream = this.harness.invoke({
    ...params,
    context: {
      ...params.context,
      spawn: (task: string, parentId: string) => this.spawnSubagent(task, parentId, params),
    },
  });
  this.mux.register(agentId, stream);
  return agentId;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/__tests__/orchestrator.test.ts -t "subagent events have parentId"`
Expected: PASS

**Step 5: Run all tests**

Run: `bun test packages/ai/__tests__/orchestrator.test.ts packages/ai/harness/__tests__/agent.test.ts`
Expected: All non-integration tests pass

**Step 6: Commit**

```bash
git add packages/ai/types.ts packages/ai/harness/agent.ts packages/ai/orchestrator.ts packages/ai/__tests__/orchestrator.test.ts
git commit -m "feat(orchestrator): set subagent parentId to spawning tool call ID"
```

---

### Task 9: Parallel subagent streaming test

Verify that two subagent tool calls in a single LLM response execute and stream in parallel.

**Files:**
- Test: `packages/ai/__tests__/orchestrator.test.ts`

**Step 1: Write the test**

Add to `packages/ai/__tests__/orchestrator.test.ts` inside the `spawnSubagent` describe:

```typescript
test("parallel subagent tool calls stream concurrently", async () => {
  // Provider: parent emits two agent tool calls, then two subagent responses, then parent final
  const provider = createDeterministicHarness({
    responses: [
      {
        events: [
          { type: "tool_call", name: "agent", input: { task: "first" } },
          { type: "tool_call", name: "agent", input: { task: "second" } },
        ],
      },
      { events: [{ type: "text", content: "First result" }] },
      { events: [{ type: "text", content: "Second result" }] },
      { events: [{ type: "text", content: "Both done" }] },
    ],
  });

  const agentTool: ToolDefinition<z.ZodObject<{ task: z.ZodString }>, string> = {
    name: "agent",
    description: "Spawn a subagent",
    schema: z.object({ task: z.string() }),
    execute: async ({ task }, ctx) => {
      const result = await ctx.spawn!(task);
      return { context: result, result };
    },
  };

  const harness = createAgentHarness({ harness: provider });
  const orchestrator = new AgentOrchestrator(harness);

  const parentAgentId = orchestrator.spawn({
    model: "deterministic",
    messages: [{ role: "user", content: "Spawn two subagents" }],
    tools: [agentTool],
    permissions: { allowlist: [{ tool: "agent" }] },
  });

  const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
  for await (const event of orchestrator.events()) {
    events.push(event);
  }

  // Should have 3 distinct agent IDs: parent + 2 subagents
  const agentIds = new Set(events.map((e) => e.agentId));
  expect(agentIds.size).toBe(3);

  // Parent should have final text
  const parentTextEvents = events.filter(
    (e) => e.agentId === parentAgentId && e.event.type === "text",
  );
  expect(parentTextEvents.length).toBeGreaterThan(0);
});
```

**Step 2: Run test**

Run: `bun test packages/ai/__tests__/orchestrator.test.ts -t "parallel subagent"`
Expected: PASS (if previous tasks implemented correctly)

**Step 3: Commit**

```bash
git add packages/ai/__tests__/orchestrator.test.ts
git commit -m "test(orchestrator): verify parallel subagent streaming"
```

---

### Task 10: Run full test suite and format

**Step 1: Run all tests**

Run: `bun test`
Expected: 136+ passing, same pre-existing failures only

**Step 2: Format**

Run: `bun run format`

**Step 3: Type check**

Run: `bun run check`
Expected: PASS

**Step 4: Commit any formatting changes**

```bash
git add -A
git commit -m "chore: format"
```
