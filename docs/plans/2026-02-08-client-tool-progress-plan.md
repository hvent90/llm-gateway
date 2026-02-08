# Client-Side Tool Progress Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable client-side rendering of `tool_progress` events with tool-specific accumulation logic shared between web and CLI.

**Architecture:** Raw `tool_progress` events flow through SSE → graph as dumb nodes. Tool-specific accumulators (co-located with tool implementations) reduce progress nodes into typed state. Thread projection attaches accumulated state to tool_call ViewNodes. UI just renders.

**Tech Stack:** TypeScript, Bun test runner

**Design doc:** `docs/plans/2026-02-08-client-tool-progress-design.md`

---

### Task 1: Add `tool_progress` to ServerEvent wire format

**Files:**
- Modify: `packages/ai/client/server-event.ts:11-61` (ServerEvent union)

**Step 1: Add tool_progress variant to ServerEvent**

Add this variant to the `ServerEvent` union in `server-event.ts`, after the `tool_result` variant (line ~41):

```ts
| {
    type: "tool_progress";
    id: string;
    runId: string;
    agentId: string;
    parentId?: string;
    toolCallId: string;
    name: string;
    content: unknown;
  }
```

**Step 2: Verify no compilation errors**

Run: `bun build --no-bundle packages/ai/client/index.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/ai/client/server-event.ts
git commit -m "feat(client): add tool_progress to ServerEvent wire format"
```

---

### Task 2: Add `tool_progress` node kind to Graph

**Files:**
- Modify: `packages/ai/client/types.ts:7-24` (Node union)
- Modify: `packages/ai/client/graph.ts:38-119` (deriveNodeId, eventToNode, reduceEvent)
- Test: `packages/ai/client/__tests__/graph.test.ts`

**Step 1: Write failing tests**

Add to `packages/ai/client/__tests__/graph.test.ts`:

```ts
test("tool_progress event creates tool_progress node", () => {
  let g = createGraph();
  g = reduceEvent(g, {
    type: "tool_progress",
    id: "tp1",
    runId: "r1",
    agentId: "a1",
    toolCallId: "tc1",
    name: "exec",
    content: { channel: "stdout", data: "hello\n" },
  });
  expect(g.nodes.size).toBe(1);
  const node = g.nodes.get("tp1")!;
  expect(node.kind).toBe("tool_progress");
  if (node.kind === "tool_progress") {
    expect(node.toolCallId).toBe("tc1");
    expect(node.name).toBe("exec");
    expect(node.content).toEqual({ channel: "stdout", data: "hello\n" });
  }
});

test("multiple tool_progress events for same toolCallId create separate nodes", () => {
  let g = createGraph();
  g = reduceEvent(g, {
    type: "tool_progress",
    id: "tp1",
    runId: "r1",
    agentId: "a1",
    toolCallId: "tc1",
    name: "exec",
    content: { channel: "stdout", data: "line1\n" },
  });
  g = reduceEvent(g, {
    type: "tool_progress",
    id: "tp2",
    runId: "r1",
    agentId: "a1",
    toolCallId: "tc1",
    name: "exec",
    content: { channel: "stdout", data: "line2\n" },
  });
  expect(g.nodes.size).toBe(2);
  expect(g.nodes.has("tp1")).toBe(true);
  expect(g.nodes.has("tp2")).toBe(true);
});

test("tool_progress creates sequential edge within run", () => {
  let g = createGraph();
  g = reduceEvent(g, {
    type: "tool_call",
    id: "tc1",
    runId: "r1",
    agentId: "a1",
    name: "exec",
    input: { command: "ls" },
  });
  g = reduceEvent(g, {
    type: "tool_progress",
    id: "tp1",
    runId: "r1",
    agentId: "a1",
    toolCallId: "tc1",
    name: "exec",
    content: { channel: "stdout", data: "file.txt\n" },
  });
  expect(g.edges.get("tc1")).toContain("tp1");
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: 3 failures — `Unknown event type: tool_progress`

**Step 3: Add tool_progress to Node type**

In `packages/ai/client/types.ts`, add to the Node union (after `tool_result`):

```ts
| { kind: "tool_progress"; toolCallId: string; name: string; content: unknown }
```

**Step 4: Handle tool_progress in graph reducer**

In `packages/ai/client/graph.ts`:

Add to `deriveNodeId` switch, after the `tool_result` case:

```ts
case "tool_progress":
  return event.id;
```

Add to `eventToNode` switch, after the `tool_result` case:

```ts
case "tool_progress":
  return { id, runId, kind: "tool_progress", toolCallId: event.toolCallId, name: event.name, content: event.content };
```

**Step 5: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: All pass

**Step 6: Run all client tests to check for regressions**

Run: `bun test packages/ai/client/`
Expected: All pass

**Step 7: Commit**

```bash
git add packages/ai/client/types.ts packages/ai/client/graph.ts packages/ai/client/__tests__/graph.test.ts
git commit -m "feat(client): add tool_progress node kind to graph"
```

---

### Task 3: Create exec progress accumulator

**Files:**
- Create: `packages/ai/rlm/exec-progress.ts`
- Create: `packages/ai/client/progress.ts` (interface + manifest + helper)
- Test: `packages/ai/rlm/__tests__/exec-progress.test.ts`

**Step 1: Write failing tests for the exec accumulator**

Create `packages/ai/rlm/__tests__/exec-progress.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { execAccumulator, type ExecProgressState } from "../exec-progress";

describe("exec progress accumulator", () => {
  test("init returns empty state", () => {
    const state = execAccumulator.init();
    expect(state).toEqual({ stdout: "", stderr: "", metrics: null });
  });

  test("stdout chunk appends to stdout buffer", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { channel: "stdout", data: "hello\n" });
    expect(state.stdout).toBe("hello\n");
    expect(state.stderr).toBe("");
  });

  test("stderr chunk appends to stderr buffer", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { channel: "stderr", data: "warn\n" });
    expect(state.stderr).toBe("warn\n");
    expect(state.stdout).toBe("");
  });

  test("multiple stdout chunks accumulate", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { channel: "stdout", data: "line1\n" });
    state = execAccumulator.reduce(state, { channel: "stdout", data: "line2\n" });
    expect(state.stdout).toBe("line1\nline2\n");
  });

  test("metrics replace previous metrics", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, {
      pid: 123,
      cpuPercent: 50,
      rssKb: 1024,
      wallMs: 1000,
    });
    expect(state.metrics).toEqual({ pid: 123, cpuPercent: 50, rssKb: 1024, wallMs: 1000 });

    state = execAccumulator.reduce(state, {
      pid: 123,
      cpuPercent: 25,
      rssKb: 2048,
      wallMs: 2000,
    });
    expect(state.metrics).toEqual({ pid: 123, cpuPercent: 25, rssKb: 2048, wallMs: 2000 });
  });

  test("interleaved stdout, stderr, and metrics", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { channel: "stdout", data: "out1\n" });
    state = execAccumulator.reduce(state, { pid: 1, cpuPercent: 10, rssKb: 100, wallMs: 500 });
    state = execAccumulator.reduce(state, { channel: "stderr", data: "err1\n" });
    state = execAccumulator.reduce(state, { channel: "stdout", data: "out2\n" });
    state = execAccumulator.reduce(state, { pid: 1, cpuPercent: 20, rssKb: 200, wallMs: 1500 });

    expect(state.stdout).toBe("out1\nout2\n");
    expect(state.stderr).toBe("err1\n");
    expect(state.metrics).toEqual({ pid: 1, cpuPercent: 20, rssKb: 200, wallMs: 1500 });
  });

  test("unrecognized content shape is ignored", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { something: "unknown" });
    expect(state).toEqual({ stdout: "", stderr: "", metrics: null });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/rlm/__tests__/exec-progress.test.ts`
Expected: Fail — module not found

**Step 3: Create the ToolProgressAccumulator interface and manifest**

Create `packages/ai/client/progress.ts`:

```ts
/**
 * A pure reducer that accumulates tool_progress event content into typed state.
 * Co-located with tool implementations; registered here via manifest.
 */
export interface ToolProgressAccumulator<TState> {
  init(): TState;
  reduce(state: TState, content: unknown): TState;
}

// --- Manifest: import accumulators from tool implementations ---
import { execAccumulator } from "../rlm/exec-progress";

const accumulators: Record<string, ToolProgressAccumulator<unknown>> = {
  exec: execAccumulator,
};

/**
 * Fold a list of raw progress content values through the appropriate accumulator.
 * Returns null if no accumulator is registered for the given tool name.
 */
export function accumulate(name: string, contentValues: unknown[]): unknown | null {
  const acc = accumulators[name];
  if (!acc) return null;
  let state = acc.init();
  for (const content of contentValues) {
    state = acc.reduce(state, content);
  }
  return state;
}
```

**Step 4: Create the exec accumulator**

Create `packages/ai/rlm/exec-progress.ts`:

```ts
import type { ToolProgressAccumulator } from "../client/progress";

export type ExecProgressState = {
  stdout: string;
  stderr: string;
  metrics: {
    pid: number;
    cpuPercent: number;
    rssKb: number;
    wallMs: number;
  } | null;
};

function isStreamChunk(content: unknown): content is { channel: "stdout" | "stderr"; data: string } {
  return (
    typeof content === "object" &&
    content !== null &&
    "channel" in content &&
    "data" in content &&
    ((content as any).channel === "stdout" || (content as any).channel === "stderr") &&
    typeof (content as any).data === "string"
  );
}

function isMetrics(
  content: unknown,
): content is { pid: number; cpuPercent: number; rssKb: number; wallMs: number } {
  return (
    typeof content === "object" &&
    content !== null &&
    "pid" in content &&
    typeof (content as any).pid === "number"
  );
}

export const execAccumulator: ToolProgressAccumulator<ExecProgressState> = {
  init: () => ({ stdout: "", stderr: "", metrics: null }),
  reduce(state, content) {
    if (isStreamChunk(content)) {
      return {
        ...state,
        [content.channel]: state[content.channel] + content.data,
      };
    }
    if (isMetrics(content)) {
      return {
        ...state,
        metrics: {
          pid: content.pid,
          cpuPercent: content.cpuPercent,
          rssKb: content.rssKb,
          wallMs: content.wallMs,
        },
      };
    }
    return state;
  },
};
```

**Step 5: Run tests to verify they pass**

Run: `bun test packages/ai/rlm/__tests__/exec-progress.test.ts`
Expected: All pass

**Step 6: Commit**

```bash
git add packages/ai/rlm/exec-progress.ts packages/ai/rlm/__tests__/exec-progress.test.ts packages/ai/client/progress.ts
git commit -m "feat(rlm): add exec progress accumulator with tests"
```

---

### Task 4: Wire accumulator into thread projection

**Files:**
- Modify: `packages/ai/client/projections/thread.ts:8-21` (ViewContent), `walkRun` function
- Test: `packages/ai/client/__tests__/projections/thread.test.ts`

**Step 1: Write failing tests**

Add to `packages/ai/client/__tests__/projections/thread.test.ts`:

```ts
test("tool_progress events accumulate into tool_call progress field", () => {
  const g = buildGraph([
    { type: "harness_start", runId: "r1", agentId: "a1" },
    {
      type: "tool_call",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "exec",
      input: { command: "ls" },
    },
    {
      type: "tool_progress",
      id: "tp1",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc1",
      name: "exec",
      content: { channel: "stdout", data: "file1.txt\n" },
    },
    {
      type: "tool_progress",
      id: "tp2",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc1",
      name: "exec",
      content: { channel: "stdout", data: "file2.txt\n" },
    },
    {
      type: "tool_result",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "exec",
      output: { stdout: "file1.txt\nfile2.txt\n" },
    },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const view = projectThread(g);
  const tcNode = view.find((v) => v.content.kind === "tool_call");
  expect(tcNode).toBeDefined();
  if (tcNode?.content.kind === "tool_call") {
    expect(tcNode.content.progress).toBeDefined();
    const progress = tcNode.content.progress as {
      stdout: string;
      stderr: string;
      metrics: unknown;
    };
    expect(progress.stdout).toBe("file1.txt\nfile2.txt\n");
    expect(progress.stderr).toBe("");
  }
});

test("tool_progress with metrics shows latest snapshot", () => {
  const g = buildGraph([
    { type: "harness_start", runId: "r1", agentId: "a1" },
    {
      type: "tool_call",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "exec",
      input: { command: "sleep 3" },
    },
    {
      type: "tool_progress",
      id: "tp1",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc1",
      name: "exec",
      content: { pid: 123, cpuPercent: 50, rssKb: 1024, wallMs: 1000 },
    },
    {
      type: "tool_progress",
      id: "tp2",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc1",
      name: "exec",
      content: { pid: 123, cpuPercent: 25, rssKb: 2048, wallMs: 2000 },
    },
    {
      type: "tool_result",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "exec",
      output: { stdout: "" },
    },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const view = projectThread(g);
  const tcNode = view.find((v) => v.content.kind === "tool_call");
  expect(tcNode).toBeDefined();
  if (tcNode?.content.kind === "tool_call") {
    const progress = tcNode.content.progress as {
      metrics: { cpuPercent: number; rssKb: number; wallMs: number };
    };
    expect(progress.metrics.cpuPercent).toBe(25);
    expect(progress.metrics.wallMs).toBe(2000);
  }
});

test("tool_call with no progress has null progress field", () => {
  const g = buildGraph([
    { type: "harness_start", runId: "r1", agentId: "a1" },
    {
      type: "tool_call",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    },
    {
      type: "tool_result",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "bash",
      output: "file.txt",
    },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const view = projectThread(g);
  const tcNode = view.find((v) => v.content.kind === "tool_call");
  expect(tcNode).toBeDefined();
  if (tcNode?.content.kind === "tool_call") {
    expect(tcNode.content.progress).toBeNull();
  }
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/projections/thread.test.ts`
Expected: Failures — `progress` property doesn't exist on tool_call ViewContent

**Step 3: Add progress field to ViewContent tool_call**

In `packages/ai/client/projections/thread.ts`, update the `tool_call` variant in `ViewContent`:

```ts
| { kind: "tool_call"; name: string; input: unknown; output?: unknown; progress?: unknown }
```

**Step 4: Collect tool_progress nodes and accumulate in walkRun**

In `packages/ai/client/projections/thread.ts`:

Add import at top:

```ts
import { accumulate } from "../progress";
```

In `nodeToViewContent`, update the `tool_call` case to include `progress: null`:

```ts
case "tool_call":
  return { kind: "tool_call", name: node.name, input: node.input, progress: null };
```

In the `walkRun` function, after the section that attaches `tool_result` output (around line 237-246), add a similar block for `tool_progress`:

```ts
// If the node is tool_progress, collect it for later accumulation
// (handled below when we encounter tool_result or at end of walk)
```

Actually, the simplest approach: in `projectThread`, after `walkRun` completes, do a second pass over the graph to collect progress and attach it. But that breaks the single-walk model.

Better approach: accumulate progress during the walk. In the `walkRun` function, when we encounter a `tool_progress` node, find the previous tool_call ViewNode by `toolCallId` and rebuild its accumulated progress. This mirrors how `tool_result` finds and modifies the tool_call ViewNode.

Add this block after the existing tool_result attachment block (after line ~246):

```ts
// If the node is tool_progress, accumulate it into the matching tool_call ViewNode
if (node.kind === "tool_progress") {
  for (let i = result.length - 1; i >= 0; i--) {
    const v = result[i]!;
    if (v.content.kind === "tool_call" && v.id === node.toolCallId) {
      // Collect all tool_progress content values for this toolCallId from the graph
      const progressContents: unknown[] = [];
      for (const n of graph.nodes.values()) {
        if (n.kind === "tool_progress" && n.toolCallId === node.toolCallId) {
          progressContents.push(n.content);
        }
      }
      v.content = { ...v.content, progress: accumulate(node.name, progressContents) };
      break;
    }
  }
}
```

Also add `tool_progress` to the structural nodes list in `nodeToViewContent` that returns null (so it doesn't create its own ViewNode):

```ts
case "harness_start":
case "harness_end":
case "usage":
case "tool_result":
case "tool_progress":
  return null;
```

**Step 5: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/projections/thread.test.ts`
Expected: All pass

**Step 6: Run full client test suite for regressions**

Run: `bun test packages/ai/client/`
Expected: All pass

**Step 7: Commit**

```bash
git add packages/ai/client/projections/thread.ts packages/ai/client/__tests__/projections/thread.test.ts
git commit -m "feat(client): wire tool_progress accumulation into thread projection"
```

---

### Task 5: Export new types from client package

**Files:**
- Modify: `packages/ai/client/index.ts`

**Step 1: Add exports**

In `packages/ai/client/index.ts`, add:

```ts
// Progress accumulation
export { accumulate } from "./progress";
export type { ToolProgressAccumulator } from "./progress";
```

**Step 2: Run full test suite**

Run: `bun test packages/ai/client/`
Expected: All pass

**Step 3: Commit**

```bash
git add packages/ai/client/index.ts
git commit -m "feat(client): export progress accumulator interface and helper"
```

---

### Task 6: Add exec progress rendering to web client

**Files:**
- Modify: `clients/web/src/components/ConversationThread.tsx:123-163` (ToolCallView)

**Step 1: Add progress rendering to ToolCallView**

In `clients/web/src/components/ConversationThread.tsx`, update `ToolCallView` to render progress when present.

Import the state type at the top:

```ts
import type { ExecProgressState } from "../../../../packages/ai/rlm/exec-progress";
```

Inside `ToolCallView`, after deriving `outputStr`, add progress extraction:

```ts
const progress = content.progress as ExecProgressState | null;
```

Inside the expanded section (`{expanded && ( ... )}`), after the output `CollapsiblePre` block and before the closing `</div>`, add:

```tsx
{progress && (progress.stdout || progress.stderr) && (
  <div className="mt-1 border-t border-neutral-800 pt-1">
    {progress.stdout && (
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-neutral-400">
        {progress.stdout}
      </pre>
    )}
    {progress.stderr && (
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-red-400">
        {progress.stderr}
      </pre>
    )}
  </div>
)}
{progress?.metrics && (
  <div className="mt-1 border-t border-neutral-800 pt-1 text-xs text-neutral-600">
    CPU: {progress.metrics.cpuPercent.toFixed(1)}% · RSS: {(progress.metrics.rssKb / 1024).toFixed(1)}MB · {(progress.metrics.wallMs / 1000).toFixed(1)}s
  </div>
)}
```

Also show a compact progress indicator on the collapsed tool_call header when streaming and progress exists (between tool name and params):

```tsx
{!expanded && progress && !outputStr && (
  <span className="shrink-0 text-neutral-600 text-xs">
    {progress.metrics ? `${(progress.metrics.wallMs / 1000).toFixed(1)}s` : "…"}
  </span>
)}
```

**Step 2: Verify manually**

Run: `bun run dev` (starts both server and web client)
Open web client, switch to RLM mode, send a message that triggers exec.
Verify progress appears during execution.

**Step 3: Commit**

```bash
git add clients/web/src/components/ConversationThread.tsx
git commit -m "feat(web): render exec progress in tool call view"
```

---

### Task 7: Format and final verification

**Step 1: Format**

Run: `bun run format`

**Step 2: Run all tests**

Run: `bun test`
Expected: All pass (known pre-existing failures in `orchestrator.test.ts` and `server/index.test.ts` are acceptable)

**Step 3: Commit if formatting changed anything**

```bash
git add -A
git commit -m "style: format"
```
