# Shared Conversation Reducer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate duplicated event-to-message logic from CLI and web clients into the shared `packages/ai/client` conversation module.

**Architecture:** The graph becomes a full conversation tree holding both user and assistant nodes. A shared reducer processes all events (ServerEvent, user, lifecycle). Selectors derive display data (ContentBlock[], tree traversal, status). Clients import the shared reducer + selectors and own only rendering.

**Tech Stack:** Bun, TypeScript, bun:test

**Design doc:** `docs/plans/2026-01-26-shared-conversation-reducer-design.md`

---

### Task 1: Switch graph reducer from HarnessEvent to ServerEvent

The graph currently accepts `HarnessEvent` (server-side type with `error: Error` and relay `respond` callback). Switch it to accept `ServerEvent` (client wire type with `error.message: string`, no `respond`, plus `connected` which we skip).

**Files:**
- Modify: `packages/ai/client/types.ts`
- Modify: `packages/ai/client/graph.ts`
- Modify: `packages/ai/client/__tests__/graph.test.ts`

**Step 1: Update graph.test.ts — change events to ServerEvent shape**

The existing tests use `HarnessEvent` shapes (e.g. `error: new Error("...")` and no `agentId` field). Update all test events to use `ServerEvent` shapes:
- All events need an `agentId` field (use `"agent-1"`)
- `error` events use `{ type: "error", runId, agentId, message: "..." }` instead of `{ error: new Error(...) }`
- Add a test that `connected` events are ignored by the graph reducer

```typescript
// Error event — change from:
state = reduceEvent(state, {
  type: "error",
  runId: "run-1",
  error: new Error("Something went wrong"),
});
// To:
state = reduceEvent(state, {
  type: "error",
  runId: "run-1",
  agentId: "agent-1",
  message: "Something went wrong",
});
```

Add `agentId: "agent-1"` to every existing test event that has a `runId`.

Add new test:
```typescript
test("reduceEvent ignores connected events", () => {
  const state = createInitialState();
  const newState = reduceEvent(state, { type: "connected", sessionId: "s-1" });
  expect(newState.nodes.size).toBe(0);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: FAIL — type errors because `reduceEvent` expects `HarnessEvent`, not `ServerEvent`

**Step 3: Update types.ts — add `role` to GraphNode**

```typescript
// packages/ai/client/types.ts
import type { ServerEvent } from "./server-event";

export interface GraphNode {
  runId: string;
  parentId?: string;
  role: "user" | "assistant";
  events: ServerEvent[];
}

export interface GraphState {
  nodes: Map<string, GraphNode>;
}
```

**Step 4: Update graph.ts — accept ServerEvent, ignore `connected`**

```typescript
// packages/ai/client/graph.ts
import type { ServerEvent } from "./server-event";
import type { GraphState, GraphNode } from "./types";

export function createInitialState(): GraphState {
  return { nodes: new Map() };
}

export function reduceEvent(state: GraphState, event: ServerEvent): GraphState {
  // Skip connected events — no runId, handled by conversation layer
  if (event.type === "connected") return state;

  const runId = event.runId;
  const parentId = "parentId" in event ? event.parentId : undefined;

  const existingNode = state.nodes.get(runId);
  const node: GraphNode = existingNode
    ? { ...existingNode, events: [...existingNode.events, event] }
    : { runId, parentId, role: "assistant", events: [event] };

  const newNodes = new Map(state.nodes);
  newNodes.set(runId, node);

  return { nodes: newNodes };
}
```

**Step 5: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/ai/client/types.ts packages/ai/client/graph.ts packages/ai/client/__tests__/graph.test.ts
git commit -m "refactor(graph): switch from HarnessEvent to ServerEvent"
```

---

### Task 2: Add getContentBlocks selector

The key selector that replaces both clients' event-to-message conversion logic. Walks a node's events in order, merges consecutive same-type blocks, and attaches tool_result output to matching tool_call blocks.

**Files:**
- Modify: `packages/ai/client/selectors.ts`
- Modify: `packages/ai/client/__tests__/selectors.test.ts`

**Step 1: Write failing tests for getContentBlocks**

Add to `selectors.test.ts`:

```typescript
import { getContentBlocks, getRole } from "../selectors";

// ... existing tests ...

describe("getContentBlocks", () => {
  test("returns text blocks from text events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "e1", agentId: "a1", content: "Hello ",
    });
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "e2", agentId: "a1", content: "world",
    });

    const blocks = getContentBlocks(state, "run-1");
    expect(blocks).toEqual([{ type: "text", content: "Hello world" }]);
  });

  test("merges consecutive text events into one block", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "e1", agentId: "a1", content: "A",
    });
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "e2", agentId: "a1", content: "B",
    });

    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({ type: "text", content: "AB" });
  });

  test("merges consecutive reasoning events into one block", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning", runId: "run-1", id: "r1", agentId: "a1", content: "Thinking",
    });
    state = reduceEvent(state, {
      type: "reasoning", runId: "run-1", id: "r2", agentId: "a1", content: "...",
    });

    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({ type: "reasoning", content: "Thinking..." });
  });

  test("creates separate blocks when type switches", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning", runId: "run-1", id: "r1", agentId: "a1", content: "Hmm",
    });
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "t1", agentId: "a1", content: "Answer",
    });

    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toEqual({ type: "reasoning", content: "Hmm" });
    expect(blocks[1]).toEqual({ type: "text", content: "Answer" });
  });

  test("creates tool_call blocks with output from tool_result", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_call", runId: "run-1", id: "tc-1", agentId: "a1",
      name: "bash", input: { command: "ls" },
    });
    state = reduceEvent(state, {
      type: "tool_result", runId: "run-1", id: "tc-1", agentId: "a1",
      name: "bash", output: { stdout: "file.txt" },
    });

    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({
      type: "tool_call",
      id: "tc-1",
      name: "bash",
      input: { command: "ls" },
      output: { stdout: "file.txt" },
    });
  });

  test("tool_call without result has no output", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_call", runId: "run-1", id: "tc-1", agentId: "a1",
      name: "bash", input: { command: "ls" },
    });

    const blocks = getContentBlocks(state, "run-1");
    expect(blocks[0]).toEqual({
      type: "tool_call",
      id: "tc-1",
      name: "bash",
      input: { command: "ls" },
    });
  });

  test("handles mixed event sequence", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning", runId: "run-1", id: "r1", agentId: "a1", content: "Let me think",
    });
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "t1", agentId: "a1", content: "I'll use a tool",
    });
    state = reduceEvent(state, {
      type: "tool_call", runId: "run-1", id: "tc-1", agentId: "a1",
      name: "bash", input: { command: "ls" },
    });
    state = reduceEvent(state, {
      type: "tool_result", runId: "run-1", id: "tc-1", agentId: "a1",
      name: "bash", output: "files",
    });
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "t2", agentId: "a1", content: "Here are the files",
    });

    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(4);
    expect(blocks[0].type).toBe("reasoning");
    expect(blocks[1]).toEqual({ type: "text", content: "I'll use a tool" });
    expect(blocks[2].type).toBe("tool_call");
    expect(blocks[3]).toEqual({ type: "text", content: "Here are the files" });
  });

  test("returns empty array for unknown runId", () => {
    const state = createInitialState();
    expect(getContentBlocks(state, "nonexistent")).toEqual([]);
  });

  test("skips error and relay events in content blocks", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "t1", agentId: "a1", content: "Hello",
    });
    state = reduceEvent(state, {
      type: "error", runId: "run-1", agentId: "a1", message: "oops",
    });

    const blocks = getContentBlocks(state, "run-1");
    expect(blocks).toEqual([{ type: "text", content: "Hello" }]);
  });
});

describe("getRole", () => {
  test("returns assistant for server event nodes", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text", runId: "run-1", id: "e1", agentId: "a1", content: "Hi",
    });
    expect(getRole(state, "run-1")).toBe("assistant");
  });

  test("returns undefined for unknown runId", () => {
    const state = createInitialState();
    expect(getRole(state, "nonexistent")).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/selectors.test.ts`
Expected: FAIL — `getContentBlocks` and `getRole` not exported

**Step 3: Implement getContentBlocks and getRole**

Add to `packages/ai/client/selectors.ts`:

```typescript
export type ContentBlock =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; output?: unknown };

export function getContentBlocks(state: GraphState, runId: string): ContentBlock[] {
  const node = state.nodes.get(runId);
  if (!node) return [];

  // Collect tool results by id for lookup
  const toolResults = new Map<string, unknown>();
  for (const event of node.events) {
    if (event.type === "tool_result") {
      toolResults.set(event.id, event.output);
    }
  }

  const blocks: ContentBlock[] = [];
  for (const event of node.events) {
    if (event.type === "text" || event.type === "reasoning") {
      const last = blocks[blocks.length - 1];
      if (last && last.type === event.type) {
        (last as { content: string }).content += event.content;
      } else {
        blocks.push({ type: event.type, content: event.content });
      }
    } else if (event.type === "tool_call") {
      const block: ContentBlock = { type: "tool_call", id: event.id, name: event.name, input: event.input };
      const output = toolResults.get(event.id);
      if (output !== undefined) {
        (block as { output?: unknown }).output = output;
      }
      blocks.push(block);
    }
    // Skip: tool_result (handled above), error, relay, connected
  }

  return blocks;
}

export function getRole(state: GraphState, runId: string): "user" | "assistant" | undefined {
  const node = state.nodes.get(runId);
  if (!node) return undefined;
  return node.role;
}
```

**Step 4: Update existing selectors.test.ts events to use ServerEvent shape**

The existing selector tests also use `HarnessEvent` shapes. Add `agentId: "a1"` to all existing test events that have `runId`. Change `error` events from `error: new Error("Failed")` to `agentId: "a1", message: "Failed"`.

**Step 5: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/selectors.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/ai/client/selectors.ts packages/ai/client/__tests__/selectors.test.ts
git commit -m "feat(selectors): add getContentBlocks and getRole"
```

---

### Task 3: Rewrite conversation reducer

Replace the current conversation reducer (which uses `HarnessEvent` + separate `userMessages[]`) with the new design: full conversation tree, `ServerEvent` input, user nodes in graph, pendingRelays, grantedTools, activeStreams.

**Files:**
- Rewrite: `packages/ai/client/conversation.ts`
- Rewrite: `packages/ai/client/__tests__/conversation.test.ts`

**Step 1: Write failing tests for the new conversation reducer**

Replace `packages/ai/client/__tests__/conversation.test.ts` entirely:

```typescript
import { describe, test, expect } from "bun:test";
import {
  createInitialConversation,
  reduceConversation,
} from "../conversation";
import type { ConversationEvent } from "../conversation";
import { getRoots, getChildren, getContentBlocks, getRole } from "../selectors";

describe("Conversation Reducer", () => {
  test("createInitialConversation returns empty state", () => {
    const state = createInitialConversation();
    expect(state.graph.nodes.size).toBe(0);
    expect(state.sessionId).toBe(null);
    expect(state.pendingRelays).toEqual([]);
    expect(state.grantedTools.size).toBe(0);
    expect(state.activeStreams.size).toBe(0);
  });

  test("connected event sets sessionId", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "connected", sessionId: "s-1" });
    expect(state.sessionId).toBe("s-1");
    expect(state.graph.nodes.size).toBe(0);
  });

  test("user event creates user node in graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "user", runId: "user-1", content: "Hello",
    });

    expect(state.graph.nodes.size).toBe(1);
    expect(getRole(state.graph, "user-1")).toBe("user");
    expect(getContentBlocks(state.graph, "user-1")).toEqual([
      { type: "text", content: "Hello" },
    ]);
  });

  test("user event with parentId creates child node", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "text", id: "e1", runId: "run-1", agentId: "a1", content: "Hi",
    });
    state = reduceConversation(state, {
      type: "user", runId: "user-1", parentId: "run-1", content: "Reply",
    });

    expect(getChildren(state.graph, "run-1")).toEqual(["user-1"]);
  });

  test("text events delegate to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "text", id: "e1", runId: "run-1", agentId: "a1", content: "Hello",
    });

    expect(state.graph.nodes.size).toBe(1);
    expect(getRole(state.graph, "run-1")).toBe("assistant");
  });

  test("relay event appends to pendingRelays", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-1", runId: "run-1",
      agentId: "a1", toolCallId: "tc-1", tool: "bash",
      params: { command: "rm -rf" },
    });

    expect(state.pendingRelays.length).toBe(1);
    expect(state.pendingRelays[0].relayId).toBe("r-1");
    expect(state.pendingRelays[0].tool).toBe("bash");
  });

  test("multiple relays accumulate", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-1", runId: "run-1",
      agentId: "a1", toolCallId: "tc-1", tool: "bash",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-2", runId: "run-1",
      agentId: "a1", toolCallId: "tc-2", tool: "read",
      params: {},
    });

    expect(state.pendingRelays.length).toBe(2);
  });

  test("relay_resolved removes relay and grants tool if approved", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-1", runId: "run-1",
      agentId: "a1", toolCallId: "tc-1", tool: "bash",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay_resolved", relayId: "r-1", tool: "bash", approved: true,
    });

    expect(state.pendingRelays.length).toBe(0);
    expect(state.grantedTools.has("bash")).toBe(true);
  });

  test("relay_resolved with denied does not grant tool", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-1", runId: "run-1",
      agentId: "a1", toolCallId: "tc-1", tool: "bash",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay_resolved", relayId: "r-1", tool: "bash", approved: false,
    });

    expect(state.pendingRelays.length).toBe(0);
    expect(state.grantedTools.has("bash")).toBe(false);
  });

  test("stream_start adds to activeStreams", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "stream_start", runId: "run-1" });
    expect(state.activeStreams.has("run-1")).toBe(true);
  });

  test("stream_end removes from activeStreams", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "stream_start", runId: "run-1" });
    state = reduceConversation(state, { type: "stream_end", runId: "run-1" });
    expect(state.activeStreams.has("run-1")).toBe(false);
  });

  test("full conversation flow", () => {
    let state = createInitialConversation();

    // Connect
    state = reduceConversation(state, { type: "connected", sessionId: "s-1" });

    // User message
    state = reduceConversation(state, {
      type: "user", runId: "user-1", content: "Hello",
    });

    // Stream starts
    state = reduceConversation(state, { type: "stream_start", runId: "run-1" });

    // Assistant replies (child of user message)
    state = reduceConversation(state, {
      type: "text", id: "e1", runId: "run-1", agentId: "a1",
      parentId: "user-1", content: "Hi there!",
    });

    // Stream ends
    state = reduceConversation(state, { type: "stream_end", runId: "run-1" });

    expect(state.sessionId).toBe("s-1");
    expect(getRoots(state.graph)).toEqual(["user-1"]);
    expect(getChildren(state.graph, "user-1")).toEqual(["run-1"]);
    expect(getContentBlocks(state.graph, "user-1")).toEqual([
      { type: "text", content: "Hello" },
    ]);
    expect(getContentBlocks(state.graph, "run-1")).toEqual([
      { type: "text", content: "Hi there!" },
    ]);
    expect(state.activeStreams.size).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/conversation.test.ts`
Expected: FAIL — old exports don't match new API

**Step 3: Implement the new conversation reducer**

Replace `packages/ai/client/conversation.ts`:

```typescript
import type { ServerEvent } from "./server-event";
import type { GraphState } from "./types";
import { createInitialState, reduceEvent } from "./graph";

export interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ConversationState {
  graph: GraphState;
  sessionId: string | null;
  pendingRelays: PendingRelay[];
  grantedTools: Set<string>;
  activeStreams: Set<string>;
}

type UserEvent = {
  type: "user";
  runId: string;
  parentId?: string;
  content: string;
  timestamp?: number;
};

export type ConversationEvent =
  | ServerEvent
  | UserEvent
  | { type: "stream_start"; runId: string }
  | { type: "stream_end"; runId: string }
  | { type: "relay_resolved"; relayId: string; tool: string; approved: boolean };

export function createInitialConversation(): ConversationState {
  return {
    graph: createInitialState(),
    sessionId: null,
    pendingRelays: [],
    grantedTools: new Set(),
    activeStreams: new Set(),
  };
}

export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case "connected":
      return { ...state, sessionId: event.sessionId };

    case "user": {
      // Create a user node in the graph
      const runId = event.runId;
      const parentId = event.parentId;
      const existingNode = state.graph.nodes.get(runId);
      const node = existingNode
        ? { ...existingNode, events: [...existingNode.events, event as any] }
        : { runId, parentId, role: "user" as const, events: [event as any] };
      const newNodes = new Map(state.graph.nodes);
      newNodes.set(runId, node);
      return { ...state, graph: { nodes: newNodes } };
    }

    case "relay": {
      const relay: PendingRelay = {
        relayId: event.id,
        runId: event.runId,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
      return { ...state, pendingRelays: [...state.pendingRelays, relay] };
    }

    case "relay_resolved": {
      const pendingRelays = state.pendingRelays.filter(
        (r) => r.relayId !== event.relayId,
      );
      const grantedTools = event.approved
        ? new Set([...state.grantedTools, event.tool])
        : state.grantedTools;
      return { ...state, pendingRelays, grantedTools };
    }

    case "stream_start": {
      const activeStreams = new Set(state.activeStreams);
      activeStreams.add(event.runId);
      return { ...state, activeStreams };
    }

    case "stream_end": {
      const activeStreams = new Set(state.activeStreams);
      activeStreams.delete(event.runId);
      return { ...state, activeStreams };
    }

    default:
      // All other ServerEvents (text, reasoning, tool_call, tool_result, error)
      // delegate to the graph reducer
      return { ...state, graph: reduceEvent(state.graph, event as ServerEvent) };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/conversation.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/conversation.ts packages/ai/client/__tests__/conversation.test.ts
git commit -m "feat(conversation): rewrite reducer with full conversation tree"
```

---

### Task 4: Update exports in index.ts

Update the barrel file to export the new types and selectors.

**Files:**
- Modify: `packages/ai/client/index.ts`

**Step 1: Update index.ts**

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
  getContentBlocks,
  getRole,
} from "./selectors";
export type { ContentBlock } from "./selectors";

// Conversation layer
export { createInitialConversation, reduceConversation } from "./conversation";
export type { ConversationState, ConversationEvent, PendingRelay } from "./conversation";

// Server event types
export type { ServerEvent, StreamRequest } from "./server-event";

// Types
export type { GraphState, GraphNode } from "./types";

// Transports
export { createSSETransport } from "./transports/sse";
export { createHTTPTransport } from "./transports/http";
```

**Step 2: Run all ai package tests to verify nothing broke**

Run: `bun test packages/ai/client/__tests__/`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/ai/client/index.ts
git commit -m "refactor(client): update exports for new conversation API"
```

---

### Task 5: Migrate web client to shared reducer

Replace the web client's local conversation state management with the shared reducer and selectors.

**Files:**
- Rewrite: `clients/web/src/state/conversation.ts`
- Modify: `clients/web/src/types.ts`
- Modify: `clients/web/src/App.tsx`
- Modify: `clients/web/src/components/ConversationThread.tsx`
- Modify: `clients/web/src/components/MessageNode.tsx`

This is the largest task. The web client currently builds a `MessageNode[]` tree with `ContentBlock[]` inside its own reducer. We replace that with: store `ConversationState` from the shared reducer, render by walking the graph with selectors.

**Step 1: Simplify types.ts**

Replace `clients/web/src/types.ts` — remove `MessageNode`, `ContentBlock`, `ConversationState`, `ToolCall`, `RelayRequest` (they now come from the ai package). Keep only what's web-specific:

```typescript
// Re-export shared types
export type { ServerEvent } from "../../../packages/ai/client/server-event";
export type {
  ConversationState,
  PendingRelay,
  ContentBlock,
} from "../../../packages/ai/client";

// Message structure for API requests
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// Permission types (matching server's packages/ai/types.ts)
export interface ToolPermission {
  tool: string;
  params?: Record<string, string>;
}

export interface Permissions {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
}
```

**Step 2: Replace state/conversation.ts**

Replace `clients/web/src/state/conversation.ts` with a thin wrapper:

```typescript
export {
  createInitialConversation as createInitialState,
  reduceConversation,
} from "../../../../packages/ai/client";
export type { ConversationEvent } from "../../../../packages/ai/client";
```

**Step 3: Update App.tsx**

The main changes:
- Use `reduceConversation` instead of `handleEvent`
- Dispatch `{ type: "user", runId, content }` instead of `addUserMessage`
- Dispatch `{ type: "stream_start" }` / `{ type: "stream_end" }` around streaming
- Dispatch `{ type: "relay_resolved" }` instead of manually updating grantedTools
- Use `state.pendingRelays[0]` instead of `state.pendingRelay`
- Use `state.activeStreams.size > 0` instead of `state.isStreaming`

Update `clients/web/src/App.tsx`:

```typescript
import { useState, useCallback, useRef } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { createSSETransport, createHTTPTransport } from "../../../packages/ai/client";
import { createInitialState, reduceConversation } from "./state/conversation";
import type { ConversationState, Message, Permissions } from "./types";

const MODEL = "nvidia/nemotron-nano-9b-v2:free";

const sseTransport = createSSETransport({ baseUrl: "" });
const httpTransport = createHTTPTransport({ baseUrl: "" });

let userIdCounter = 0;
function nextUserId(): string {
  return `user-${++userIdCounter}`;
}

export default function App() {
  const [state, setState] = useState<ConversationState>(createInitialState);
  const abortControllerRef = useRef<AbortController | null>(null);

  const isStreaming = state.activeStreams.size > 0;
  const pendingRelay = state.pendingRelays[0] ?? null;

  // Build messages array from graph for API requests
  const buildMessagesFromState = useCallback(
    (graph: ConversationState["graph"]): Message[] => {
      const { getRoots, getChildren, getContentBlocks, getRole } = require("../../../packages/ai/client");
      const messages: Message[] = [];
      const traverse = (runIds: string[]) => {
        for (const runId of runIds) {
          const role = getRole(graph, runId);
          const blocks = getContentBlocks(graph, runId);
          const textContent = blocks
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.content)
            .join("");
          if (textContent && role) {
            messages.push({ role, content: textContent });
          }
          traverse(getChildren(graph, runId));
        }
      };
      traverse(getRoots(graph));
      return messages;
    },
    [],
  );

  const sendChat = useCallback(async (messages: Message[], permissions: Permissions) => {
    const streamRunId = `stream-${Date.now()}`;
    setState((s) => reduceConversation(s, { type: "stream_start", runId: streamRunId }));

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const stream = sseTransport.stream(
        { model: MODEL, messages, permissions },
        controller.signal,
      );

      for await (const event of stream) {
        setState((s) => reduceConversation(s, event));
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Stream error:", error);
      }
    } finally {
      setState((s) => reduceConversation(s, { type: "stream_end", runId: streamRunId }));
      abortControllerRef.current = null;
    }
  }, []);

  const handleSubmit = useCallback(
    async (content: string) => {
      const userRunId = nextUserId();
      setState((s) => reduceConversation(s, { type: "user", runId: userRunId, content }));

      const messages = buildMessagesFromState(state.graph);
      messages.push({ role: "user", content });

      const permissions: Permissions = {
        allowlist: Array.from(state.grantedTools).map((tool) => ({ tool })),
      };

      await sendChat(messages, permissions);
    },
    [state.graph, state.grantedTools, buildMessagesFromState, sendChat],
  );

  const handleAllow = useCallback(async () => {
    if (!pendingRelay || !state.sessionId) return;

    setState((s) =>
      reduceConversation(s, {
        type: "relay_resolved",
        relayId: pendingRelay.relayId,
        tool: pendingRelay.tool,
        approved: true,
      }),
    );
    await httpTransport.resolveRelay(state.sessionId, pendingRelay.relayId, { approved: true });
  }, [state.sessionId, pendingRelay]);

  const handleAllowAll = useCallback(async () => {
    if (!pendingRelay || !state.sessionId) return;

    setState((s) =>
      reduceConversation(s, {
        type: "relay_resolved",
        relayId: pendingRelay.relayId,
        tool: pendingRelay.tool,
        approved: true,
      }),
    );
    await httpTransport.resolveRelay(state.sessionId, pendingRelay.relayId, { approved: true });
  }, [state.sessionId, pendingRelay]);

  const handleDeny = useCallback(async () => {
    if (!pendingRelay || !state.sessionId) return;

    setState((s) =>
      reduceConversation(s, {
        type: "relay_resolved",
        relayId: pendingRelay.relayId,
        tool: pendingRelay.tool,
        approved: false,
      }),
    );
    await httpTransport.resolveRelay(state.sessionId, pendingRelay.relayId, {
      approved: false,
      reason: "User denied",
    });
  }, [state.sessionId, pendingRelay]);

  return (
    <div className="flex h-dvh flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-3 sm:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 overflow-auto p-3 sm:p-4">
        <ConversationThread graph={state.graph} />
        {pendingRelay && (
          <PermissionPrompt
            request={pendingRelay}
            onAllow={handleAllow}
            onAllowAll={handleAllowAll}
            onDeny={handleDeny}
          />
        )}
      </main>
      <InputArea
        onSubmit={handleSubmit}
        disabled={isStreaming || pendingRelay !== null}
      />
    </div>
  );
}
```

Note: The `buildMessagesFromState` function above uses a `require` call which is a placeholder. The actual implementation should use static imports — this will be refined during implementation. The imports at the top of the file should include `getRoots`, `getChildren`, `getContentBlocks`, `getRole` from the ai package.

**Step 4: Update ConversationThread.tsx**

Change from receiving `messages: MessageNode[]` to receiving `graph: GraphState` and using selectors to traverse:

```tsx
import { getRoots, getChildren, getContentBlocks, getRole } from "../../../../packages/ai/client";
import type { GraphState } from "../../../../packages/ai/client";

// Render a single node and its children
function NodeView({ graph, runId, depth = 0 }: { graph: GraphState; runId: string; depth?: number }) {
  const role = getRole(graph, runId);
  const blocks = getContentBlocks(graph, runId);
  const children = getChildren(graph, runId);

  // ... render blocks and recursively render children using <NodeView>
}

export function ConversationThread({ graph }: { graph: GraphState }) {
  const roots = getRoots(graph);
  // ... render roots using <NodeView>
}
```

The exact rendering logic should be preserved from the existing MessageNode.tsx component — just change the data source from `node.contentBlocks` to `getContentBlocks(graph, runId)` and from `node.children` to `getChildren(graph, runId)`.

**Step 5: Update MessageNode.tsx**

Either merge into ConversationThread or update to accept `graph` + `runId` props instead of `node: MessageNode`. The rendering of individual content blocks (text, reasoning, tool_call) stays the same.

**Step 6: Update PermissionPrompt.tsx**

Change the prop type from `request: RelayRequest` to `request: PendingRelay` (imported from the ai package). The fields are the same shape so this should just be a type import change.

**Step 7: Test manually**

Run: `bun run dev:web`
Verify the web UI renders conversations correctly.

**Step 8: Commit**

```bash
git add clients/web/src/
git commit -m "refactor(web): migrate to shared conversation reducer"
```

---

### Task 6: Migrate CLI client to shared reducer

Replace the CLI client's local event handling with the shared reducer and selectors.

**Files:**
- Modify: `clients/cli/index.tsx`

**Step 1: Rewrite CLI to use shared reducer**

Key changes to `clients/cli/index.tsx`:
- Remove local `Message` interface, `handleEvent` function, `formatOutput` helper
- Import `createInitialConversation`, `reduceConversation`, `getRoots`, `getChildren`, `getContentBlocks`, `getRole` from ai package
- Store `ConversationState` in a Solid signal instead of `messages[]`
- Render by walking the graph with selectors
- Dispatch `stream_start` / `stream_end` around the streaming loop
- Dispatch `relay_resolved` when user approves/denies

The `MessageView` component changes from rendering a flat `Message` to rendering content blocks for a given `runId`:

```tsx
function NodeView(props: { graph: GraphState; runId: string }) {
  const role = () => getRole(props.graph, props.runId);
  const blocks = () => getContentBlocks(props.graph, props.runId);
  const children = () => getChildren(props.graph, props.runId);

  return (
    <box marginTop={role() === "user" ? 1 : 0} marginBottom={role() === "user" ? 1 : 0}>
      <For each={blocks()}>
        {(block) => (
          <Show when={block.type === "reasoning"} fallback={
            <Show when={block.type === "text"} fallback={
              // tool_call block
              <text wrapMode="word">
                {`[tool] ${(block as any).name}: ${JSON.stringify((block as any).input)}`}
              </text>
            }>
              <text wrapMode="word">
                {role() === "user" ? "You: " : ""}{(block as any).content.trimEnd()}
              </text>
            </Show>
          }>
            <box paddingLeft={2} borderLeft borderColor="gray">
              <text wrapMode="word" fg="gray" attributes={createTextAttributes({ dim: true, italic: true })}>
                {(block as any).content.trimEnd()}
              </text>
            </box>
          </Show>
        )}
      </For>
      <For each={children()}>
        {(childId) => <NodeView graph={props.graph} runId={childId} />}
      </For>
    </box>
  );
}
```

The streaming loop changes from:
```typescript
const state = { currentMsgId: null, isReasoning: false };
for await (const event of stream) {
  handleEvent(event, state);
}
```
To:
```typescript
for await (const event of stream) {
  setConversation((s) => reduceConversation(s, event));
}
```

Relay handling changes from manual `setPendingRelay` / `setPendingRelay(null)` to dispatching `relay_resolved` events.

**Step 2: Test manually**

Run: `bun run dev:cli` (or `cd clients/cli && bun run index.tsx`)
Verify the CLI renders conversations correctly.

**Step 3: Commit**

```bash
git add clients/cli/index.tsx
git commit -m "refactor(cli): migrate to shared conversation reducer"
```

---

### Task 7: Clean up removed types and run format

Remove any dead code left over from the migration.

**Files:**
- Possibly: `clients/web/src/types.ts` — remove unused types if any remain
- All modified files

**Step 1: Run the formatter**

Run: `bun run format`

**Step 2: Run type checking**

Run: `bun run check`

Fix any type errors.

**Step 3: Run all tests**

Run: `bun test`

All tests should pass.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: clean up and format after conversation reducer migration"
```
