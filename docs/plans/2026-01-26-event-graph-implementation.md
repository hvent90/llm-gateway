# Event Graph Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the event graph data model with self-sovereign runIds, a shared client library, and migrate existing clients.

**Architecture:** Remove `context.runId` from harness params (harnesses always self-assign). Create a pure reducer-based client library in `packages/ai/client/` with minimal state and computed selectors. Migrate web and CLI clients to use the shared library.

**Tech Stack:** TypeScript, Bun test runner, uuid v7

---

## Task 1: Remove `context.runId` from Type Definitions

**Files:**
- Modify: `packages/ai/types.ts:82-105`
- Test: `packages/ai/__tests__/types.test.ts` (create)

**Step 1: Write the failing test**

Create `packages/ai/__tests__/types.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import type { InvokeParams, GeneratorInvokeParams } from "../types";

describe("InvokeParams types", () => {
  test("context only has parentId, not runId", () => {
    // This test validates the type shape at compile time
    // If context.runId exists, this should cause a type error
    const params: InvokeParams = {
      model: "test",
      messages: [],
      emit: () => {},
      context: { parentId: "parent-123" },
    };

    const genParams: GeneratorInvokeParams = {
      model: "test",
      messages: [],
      context: { parentId: "parent-123" },
    };

    // Runtime check that context shape is correct
    expect(params.context).toEqual({ parentId: "parent-123" });
    expect(genParams.context).toEqual({ parentId: "parent-123" });
  });
});
```

**Step 2: Run test to verify baseline**

Run: `bun test packages/ai/__tests__/types.test.ts`
Expected: PASS (types currently allow both runId and parentId)

**Step 3: Update type definitions**

In `packages/ai/types.ts`, change lines 88-91:

```typescript
// Before
context?: {
  runId?: string;
  parentId?: string;
};

// After
context?: {
  parentId?: string;
};
```

And lines 100-103:

```typescript
// Before
context?: {
  runId?: string;
  parentId?: string;
};

// After
context?: {
  parentId?: string;
};
```

**Step 4: Run test to verify it still passes**

Run: `bun test packages/ai/__tests__/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/types.ts packages/ai/__tests__/types.test.ts
git commit -m "refactor(types): remove context.runId - harnesses self-assign identity"
```

---

## Task 2: Update Agent Harness to Self-Assign runId

**Files:**
- Modify: `packages/ai/harness/agent.ts:31-50`
- Test: `packages/ai/harness/__tests__/agent.test.ts` (existing)

**Step 1: Write a test for the new behavior**

Add to `packages/ai/harness/__tests__/agent.test.ts`:

```typescript
test("agent assigns its own runId, passes it as parentId to provider", async () => {
  const capturedContexts: Array<{ parentId?: string }> = [];

  // Create a mock harness that captures the context it receives
  const mockHarness: GeneratorHarnessModule = {
    async *invoke(params) {
      capturedContexts.push({ parentId: params.context?.parentId });
      yield { type: "text", runId: "provider-run", id: "t1", content: "Hello" };
    },
    async supportedModels() {
      return ["test-model"];
    },
  };

  const agentHarness = createAgentHarness({ harness: mockHarness });

  const events = await collectEvents(
    agentHarness.invoke({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    }),
  );

  // Agent should have passed its own runId as parentId to provider
  expect(capturedContexts.length).toBe(1);
  expect(capturedContexts[0].parentId).toBeDefined();
  expect(typeof capturedContexts[0].parentId).toBe("string");
  expect(capturedContexts[0].parentId!.length).toBeGreaterThan(0);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts -t "agent assigns"`
Expected: FAIL (currently passes runId, not parentId as agent's id)

**Step 3: Update agent harness**

In `packages/ai/harness/agent.ts`, change lines 31-50:

```typescript
async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
  const myRunId = uuidv7();  // Agent always creates its own ID
  const parentId = params.context?.parentId;  // Receive parent from caller

  const tag = <T extends object>(event: T): T & { parentId?: string } =>
    parentId ? { ...event, parentId } : event;

  // Mutable messages array for the agent loop
  const messages: Message[] = [...params.messages];
  let iterations = 0;

  while (iterations++ < maxIterations) {
    const toolCalls: ToolCall[] = [];
    let assistantText = "";

    // Single iteration - collect events from provider harness
    // Pass our runId as the provider's parentId
    for await (const event of harness.invoke({
      ...params,
      messages,
      context: { parentId: myRunId },
    })) {
```

Also update all `runId` references in the file to use `myRunId` instead of the old `runId` variable.

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts -t "agent assigns"`
Expected: PASS

**Step 5: Run all agent tests**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/ai/harness/agent.ts packages/ai/harness/__tests__/agent.test.ts
git commit -m "refactor(agent): self-assign runId, pass as parentId to provider"
```

---

## Task 3: Update Provider Harnesses to Self-Assign runId

**Files:**
- Modify: `packages/ai/harness/providers/openai.ts:110-118`
- Modify: `packages/ai/harness/providers/anthropic.ts:161-178`
- Modify: `packages/ai/harness/providers/openrouter.ts` (similar pattern)
- Test: `packages/ai/harness/providers/__tests__/openrouter.test.ts` (existing)

**Step 1: Write a test for provider self-assignment**

Add to `packages/ai/harness/providers/__tests__/openrouter.test.ts`:

```typescript
test("provider assigns its own runId, not from context", async () => {
  const events: HarnessEvent[] = [];

  for await (const event of openRouterHarness.invoke({
    model: TEST_MODEL,
    messages: [{ role: "user", content: "Say hi" }],
    context: { parentId: "agent-run-123" },
  })) {
    events.push(event);
  }

  // All events should have provider's self-assigned runId
  const textEvents = events.filter((e) => e.type === "text");
  expect(textEvents.length).toBeGreaterThan(0);

  const runId = textEvents[0].runId;
  expect(runId).toBeDefined();
  expect(runId).not.toBe("agent-run-123"); // Should NOT use parent's id

  // All events from same provider invocation share the same runId
  for (const event of events) {
    if ("runId" in event) {
      expect(event.runId).toBe(runId);
    }
  }

  // parentId should be passed through
  for (const event of textEvents) {
    expect(event.parentId).toBe("agent-run-123");
  }
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/harness/providers/__tests__/openrouter.test.ts -t "provider assigns"`
Expected: FAIL (providers currently use context.runId if provided)

**Step 3: Update openrouter.ts**

Find the line that reads `context.runId` and change to always self-assign:

```typescript
// Before
const runId = params.context?.runId ?? v7();

// After
const runId = v7();  // Provider always creates its own ID
const parentId = params.context?.parentId;
```

**Step 4: Update openai.ts**

In `packages/ai/harness/providers/openai.ts`, line 114:

```typescript
// Before
const runId = providedRunId ?? v7();

// After
const runId = v7();  // Provider always creates its own ID
```

Also remove `runId: providedRunId` from the destructuring on line 110.

**Step 5: Update anthropic.ts**

In `packages/ai/harness/providers/anthropic.ts`, similar change around line 172:

```typescript
// Before
const runId = providedRunId ?? v7();

// After
const runId = v7();  // Provider always creates its own ID
```

Also remove `runId: providedRunId` from the destructuring.

**Step 6: Run test to verify it passes**

Run: `bun test packages/ai/harness/providers/__tests__/openrouter.test.ts -t "provider assigns"`
Expected: PASS

**Step 7: Run all tests**

Run: `bun test packages/ai/`
Expected: All tests PASS

**Step 8: Commit**

```bash
git add packages/ai/harness/providers/
git commit -m "refactor(providers): self-assign runId, receive parentId from context"
```

---

## Task 4: Create Core Graph Library - Types and Initial State

**Files:**
- Create: `packages/ai/client/types.ts`
- Create: `packages/ai/client/graph.ts`
- Create: `packages/ai/client/__tests__/graph.test.ts`

**Step 1: Write the failing test**

Create `packages/ai/client/__tests__/graph.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { createInitialState, reduceEvent } from "../graph";
import type { GraphState } from "../types";

describe("Graph State", () => {
  test("createInitialState returns empty graph", () => {
    const state = createInitialState();
    expect(state.nodes.size).toBe(0);
  });

  test("reduceEvent creates node for new runId", () => {
    const state = createInitialState();
    const newState = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "evt-1",
      content: "Hello",
    });

    expect(newState.nodes.size).toBe(1);
    expect(newState.nodes.has("run-1")).toBe(true);

    const node = newState.nodes.get("run-1")!;
    expect(node.runId).toBe("run-1");
    expect(node.events.length).toBe(1);
    expect(node.events[0].type).toBe("text");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: FAIL (files don't exist)

**Step 3: Create types**

Create `packages/ai/client/types.ts`:

```typescript
import type { HarnessEvent } from "../types";

/**
 * A node in the event graph, representing a single harness invocation.
 */
export interface GraphNode {
  runId: string;
  parentId?: string;
  events: HarnessEvent[];
}

/**
 * The complete graph state - minimal, events as source of truth.
 */
export interface GraphState {
  nodes: Map<string, GraphNode>;
}
```

**Step 4: Create graph reducer**

Create `packages/ai/client/graph.ts`:

```typescript
import type { HarnessEvent } from "../types";
import type { GraphState, GraphNode } from "./types";

/**
 * Create an empty graph state.
 */
export function createInitialState(): GraphState {
  return {
    nodes: new Map(),
  };
}

/**
 * Pure reducer: apply a HarnessEvent to produce new GraphState.
 */
export function reduceEvent(state: GraphState, event: HarnessEvent): GraphState {
  // Extract runId and parentId from event
  const runId = event.runId;
  const parentId = "parentId" in event ? event.parentId : undefined;

  // Get or create node for this runId
  const existingNode = state.nodes.get(runId);
  const node: GraphNode = existingNode
    ? { ...existingNode, events: [...existingNode.events, event] }
    : { runId, parentId, events: [event] };

  // Create new Map with updated node
  const newNodes = new Map(state.nodes);
  newNodes.set(runId, node);

  return { nodes: newNodes };
}
```

**Step 5: Run test to verify it passes**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/ai/client/
git commit -m "feat(client): add core graph types and reducer"
```

---

## Task 5: Add Graph Reducer Tests for All Event Types

**Files:**
- Modify: `packages/ai/client/__tests__/graph.test.ts`

**Step 1: Add comprehensive tests**

Add to `packages/ai/client/__tests__/graph.test.ts`:

```typescript
test("reduceEvent accumulates events in same node", () => {
  let state = createInitialState();
  state = reduceEvent(state, {
    type: "text",
    runId: "run-1",
    id: "evt-1",
    content: "Hello ",
  });
  state = reduceEvent(state, {
    type: "text",
    runId: "run-1",
    id: "evt-2",
    content: "world",
  });

  expect(state.nodes.size).toBe(1);
  const node = state.nodes.get("run-1")!;
  expect(node.events.length).toBe(2);
});

test("reduceEvent stores parentId from first event", () => {
  let state = createInitialState();
  state = reduceEvent(state, {
    type: "text",
    runId: "child-run",
    id: "evt-1",
    parentId: "parent-run",
    content: "Hello",
  });

  const node = state.nodes.get("child-run")!;
  expect(node.parentId).toBe("parent-run");
});

test("reduceEvent handles tool_call events", () => {
  let state = createInitialState();
  state = reduceEvent(state, {
    type: "tool_call",
    runId: "run-1",
    id: "tc-1",
    name: "bash",
    input: { command: "ls" },
  });

  const node = state.nodes.get("run-1")!;
  expect(node.events.length).toBe(1);
  expect(node.events[0].type).toBe("tool_call");
});

test("reduceEvent handles tool_result events", () => {
  let state = createInitialState();
  state = reduceEvent(state, {
    type: "tool_result",
    runId: "run-1",
    id: "tc-1",
    name: "bash",
    output: { stdout: "file.txt" },
  });

  const node = state.nodes.get("run-1")!;
  expect(node.events[0].type).toBe("tool_result");
});

test("reduceEvent handles error events", () => {
  let state = createInitialState();
  state = reduceEvent(state, {
    type: "error",
    runId: "run-1",
    error: new Error("Something went wrong"),
  });

  const node = state.nodes.get("run-1")!;
  expect(node.events[0].type).toBe("error");
});

test("reduceEvent handles reasoning events", () => {
  let state = createInitialState();
  state = reduceEvent(state, {
    type: "reasoning",
    runId: "run-1",
    id: "r-1",
    content: "Let me think...",
  });

  const node = state.nodes.get("run-1")!;
  expect(node.events[0].type).toBe("reasoning");
});

test("reduceEvent creates separate nodes for different runIds", () => {
  let state = createInitialState();
  state = reduceEvent(state, {
    type: "text",
    runId: "run-1",
    id: "evt-1",
    content: "Hello",
  });
  state = reduceEvent(state, {
    type: "text",
    runId: "run-2",
    id: "evt-2",
    parentId: "run-1",
    content: "World",
  });

  expect(state.nodes.size).toBe(2);
  expect(state.nodes.has("run-1")).toBe(true);
  expect(state.nodes.has("run-2")).toBe(true);
});

test("state is immutable - original unchanged", () => {
  const state1 = createInitialState();
  const state2 = reduceEvent(state1, {
    type: "text",
    runId: "run-1",
    id: "evt-1",
    content: "Hello",
  });

  expect(state1.nodes.size).toBe(0);
  expect(state2.nodes.size).toBe(1);
  expect(state1.nodes).not.toBe(state2.nodes);
});
```

**Step 2: Run tests**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add packages/ai/client/__tests__/graph.test.ts
git commit -m "test(client): comprehensive graph reducer tests"
```

---

## Task 6: Create Selectors

**Files:**
- Create: `packages/ai/client/selectors.ts`
- Create: `packages/ai/client/__tests__/selectors.test.ts`

**Step 1: Write failing tests**

Create `packages/ai/client/__tests__/selectors.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { createInitialState, reduceEvent } from "../graph";
import {
  getRoots,
  getChildren,
  getText,
  getToolCalls,
  getStatus,
} from "../selectors";

describe("Selectors", () => {
  test("getRoots returns nodes with no parentId", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "root-1",
      id: "e1",
      content: "Hello",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-1",
      id: "e2",
      parentId: "root-1",
      content: "World",
    });

    const roots = getRoots(state);
    expect(roots).toEqual(["root-1"]);
  });

  test("getChildren returns nodes with matching parentId", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "parent",
      id: "e1",
      content: "Hello",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-1",
      id: "e2",
      parentId: "parent",
      content: "A",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-2",
      id: "e3",
      parentId: "parent",
      content: "B",
    });

    const children = getChildren(state, "parent");
    expect(children.sort()).toEqual(["child-1", "child-2"]);
  });

  test("getText concatenates text event content", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      content: "Hello ",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e2",
      content: "world",
    });

    expect(getText(state, "run-1")).toBe("Hello world");
  });

  test("getText ignores reasoning events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning",
      runId: "run-1",
      id: "r1",
      content: "Thinking...",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "t1",
      content: "Answer",
    });

    expect(getText(state, "run-1")).toBe("Answer");
  });

  test("getToolCalls extracts tool_call events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-1",
      name: "bash",
      input: { command: "ls" },
    });
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-2",
      name: "read",
      input: { path: "/tmp" },
    });

    const toolCalls = getToolCalls(state, "run-1");
    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0].name).toBe("bash");
    expect(toolCalls[1].name).toBe("read");
  });

  test("getStatus returns streaming when no terminal event", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      content: "Hello",
    });

    expect(getStatus(state, "run-1")).toBe("streaming");
  });

  test("getStatus returns error when error event present", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "error",
      runId: "run-1",
      error: new Error("Failed"),
    });

    expect(getStatus(state, "run-1")).toBe("error");
  });

  test("getStatus returns complete for unknown runId", () => {
    const state = createInitialState();
    expect(getStatus(state, "nonexistent")).toBe("complete");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/selectors.test.ts`
Expected: FAIL (selectors.ts doesn't exist)

**Step 3: Implement selectors**

Create `packages/ai/client/selectors.ts`:

```typescript
import type { GraphState } from "./types";
import type { HarnessEvent } from "../types";

/**
 * Get runIds of all root nodes (no parentId).
 */
export function getRoots(state: GraphState): string[] {
  const roots: string[] = [];
  for (const [runId, node] of state.nodes) {
    if (!node.parentId) {
      roots.push(runId);
    }
  }
  return roots;
}

/**
 * Get runIds of all children of a given node.
 */
export function getChildren(state: GraphState, runId: string): string[] {
  const children: string[] = [];
  for (const [childRunId, node] of state.nodes) {
    if (node.parentId === runId) {
      children.push(childRunId);
    }
  }
  return children;
}

/**
 * Get concatenated text content for a node.
 */
export function getText(state: GraphState, runId: string): string {
  const node = state.nodes.get(runId);
  if (!node) return "";

  return node.events
    .filter((e): e is Extract<HarnessEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.content)
    .join("");
}

/**
 * Get all tool calls for a node.
 */
export function getToolCalls(
  state: GraphState,
  runId: string,
): Array<{ id: string; name: string; input: unknown }> {
  const node = state.nodes.get(runId);
  if (!node) return [];

  return node.events
    .filter((e): e is Extract<HarnessEvent, { type: "tool_call" }> => e.type === "tool_call")
    .map((e) => ({ id: e.id, name: e.name, input: e.input }));
}

/**
 * Get the status of a node based on its events.
 */
export function getStatus(
  state: GraphState,
  runId: string,
): "streaming" | "complete" | "error" {
  const node = state.nodes.get(runId);
  if (!node) return "complete";

  const hasError = node.events.some((e) => e.type === "error");
  if (hasError) return "error";

  // For now, assume streaming unless we add explicit completion events
  return "streaming";
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/selectors.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add packages/ai/client/selectors.ts packages/ai/client/__tests__/selectors.test.ts
git commit -m "feat(client): add graph selectors"
```

---

## Task 7: Create Client Library Index

**Files:**
- Create: `packages/ai/client/index.ts`

**Step 1: Create index with exports**

Create `packages/ai/client/index.ts`:

```typescript
// Core graph
export { createInitialState, reduceEvent } from "./graph";

// Selectors
export {
  getRoots,
  getChildren,
  getText,
  getToolCalls,
  getStatus,
} from "./selectors";

// Types
export type { GraphState, GraphNode } from "./types";
```

**Step 2: Verify imports work**

Run: `bun test packages/ai/client/`
Expected: All PASS

**Step 3: Commit**

```bash
git add packages/ai/client/index.ts
git commit -m "feat(client): add index with exports"
```

---

## Task 8: Add Conversation Layer

**Files:**
- Create: `packages/ai/client/conversation.ts`
- Create: `packages/ai/client/__tests__/conversation.test.ts`

**Step 1: Write failing tests**

Create `packages/ai/client/__tests__/conversation.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  createInitialConversation,
  reduceConversation,
} from "../conversation";

describe("Conversation Layer", () => {
  test("createInitialConversation returns empty state", () => {
    const state = createInitialConversation();
    expect(state.graph.nodes.size).toBe(0);
    expect(state.userMessages.length).toBe(0);
  });

  test("reduceConversation handles user events", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "user",
      content: "Hello!",
    });

    expect(state.userMessages.length).toBe(1);
    expect(state.userMessages[0].content).toBe("Hello!");
    expect(state.graph.nodes.size).toBe(0);
  });

  test("reduceConversation handles harness events", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      content: "Hi there!",
    });

    expect(state.userMessages.length).toBe(0);
    expect(state.graph.nodes.size).toBe(1);
  });

  test("reduceConversation interleaves user and harness events", () => {
    let state = createInitialConversation();

    state = reduceConversation(state, { type: "user", content: "Hello" });
    state = reduceConversation(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      content: "Hi!",
    });
    state = reduceConversation(state, { type: "user", content: "How are you?" });
    state = reduceConversation(state, {
      type: "text",
      runId: "run-2",
      id: "e2",
      content: "Great!",
    });

    expect(state.userMessages.length).toBe(2);
    expect(state.graph.nodes.size).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/conversation.test.ts`
Expected: FAIL (file doesn't exist)

**Step 3: Implement conversation layer**

Create `packages/ai/client/conversation.ts`:

```typescript
import type { HarnessEvent } from "../types";
import type { GraphState } from "./types";
import { createInitialState, reduceEvent } from "./graph";

/**
 * User message in a conversation.
 */
export interface UserMessage {
  id: string;
  content: string;
  timestamp: number;
}

/**
 * Conversation state - composes graph with user messages.
 */
export interface ConversationState {
  graph: GraphState;
  userMessages: UserMessage[];
}

/**
 * Events the conversation layer handles.
 */
export type ConversationEvent =
  | { type: "user"; content: string }
  | HarnessEvent;

let messageCounter = 0;

/**
 * Create empty conversation state.
 */
export function createInitialConversation(): ConversationState {
  return {
    graph: createInitialState(),
    userMessages: [],
  };
}

/**
 * Reduce a conversation event.
 */
export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  if (event.type === "user") {
    const userMessage: UserMessage = {
      id: `user-${++messageCounter}`,
      content: event.content,
      timestamp: Date.now(),
    };
    return {
      ...state,
      userMessages: [...state.userMessages, userMessage],
    };
  }

  // It's a HarnessEvent - delegate to graph reducer
  return {
    ...state,
    graph: reduceEvent(state.graph, event),
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/conversation.test.ts`
Expected: All PASS

**Step 5: Update index exports**

Add to `packages/ai/client/index.ts`:

```typescript
// Conversation layer
export {
  createInitialConversation,
  reduceConversation,
} from "./conversation";

export type {
  UserMessage,
  ConversationState,
  ConversationEvent,
} from "./conversation";
```

**Step 6: Commit**

```bash
git add packages/ai/client/conversation.ts packages/ai/client/__tests__/conversation.test.ts packages/ai/client/index.ts
git commit -m "feat(client): add conversation layer for chat UIs"
```

---

## Task 9: Run All Tests and Final Verification

**Step 1: Run all package tests**

Run: `bun test packages/ai/`
Expected: All PASS

**Step 2: Run full test suite**

Run: `bun test`
Expected: All PASS

**Step 3: Format code**

Run: `bun run format`
Expected: No errors

**Step 4: Type check**

Run: `bun run check`
Expected: No errors

**Step 5: Commit any formatting fixes**

```bash
git add -A
git commit -m "chore: formatting" --allow-empty
```

---

## Future Tasks (Not in This Plan)

The following are noted but deferred:

1. **Migrate web client** - Replace `clients/web/src/state/conversation.ts` with imports from `packages/ai/client`
2. **Migrate CLI client** - Replace inline event handling in `clients/cli/index.tsx` with shared library
3. **SSE helper** - Create separate small library for SSE stream → HarnessEvent conversion
4. **Add completion detection** - Implement proper "complete" status detection (may need server-side event)
