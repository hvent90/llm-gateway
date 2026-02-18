# Summarization POC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `POST /summarize` endpoint that takes messages and returns a streaming summary, plus client-side graph wiring.

**Architecture:** New server route invokes the provider harness directly (no agent loop, no tools) with a summarization system prompt. Client collects the streamed text and calls `operations.summarize()` to wire the summary into the hypergraph.

**Tech Stack:** Bun, Hono (SSE streaming), deterministic harness for tests, hypergraph operations.

---

### Task 1: Server — `POST /summarize` endpoint

**Files:**
- Modify: `server/index.ts` (add route + `SummarizeRequest` type)

**Step 1: Write the failing test**

Create `server/summarize.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { createApp } from "./index";
import { createDeterministicHarness } from "../packages/ai/harness/providers/deterministic";
import { createAgentHarness } from "../packages/ai/harness/agent";

async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ event: string; data: unknown }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let currentEvent = "";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();
        } else if (line === "" && currentEvent && currentData) {
          yield { event: currentEvent, data: JSON.parse(currentData) };
          currentEvent = "";
          currentData = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe("POST /summarize", () => {
  it("returns 400 for invalid JSON", async () => {
    const harness = createAgentHarness({
      harness: createDeterministicHarness({ responses: [], models: ["m"] }),
    });
    const app = await createApp({ harness });

    const response = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 when model or messages missing", async () => {
    const harness = createAgentHarness({
      harness: createDeterministicHarness({ responses: [], models: ["m"] }),
    });
    const app = await createApp({ harness });

    const response = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    expect(response.status).toBe(400);
  });

  it("streams summary text events", async () => {
    const providerHarness = createDeterministicHarness({
      responses: [{ events: [{ type: "text", content: "This is a summary." }] }],
      models: ["m"],
    });
    const agentHarness = createAgentHarness({ harness: providerHarness });
    const app = await createApp({ harness: agentHarness });

    const response = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
        ],
        sourceIds: ["msg_1", "msg_2"],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events: Array<{ event: string; data: any }> = [];
    for await (const e of parseSSE(response.body!)) {
      events.push(e);
    }

    // Should have text event with summary content
    const textEvents = events.filter((e) => e.event === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0].data.content).toBe("This is a summary.");

    // Should echo sourceIds in connected event
    const connected = events.find((e) => e.event === "connected");
    expect(connected?.data.sourceIds).toEqual(["msg_1", "msg_2"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test server/summarize.test.ts`
Expected: FAIL — route not found (404)

**Step 3: Implement the endpoint**

In `server/index.ts`, add after the `ChatRequest` interface:

```typescript
interface SummarizeRequest {
  model: string;
  messages: Message[];
  sourceIds: string[];
}
```

Add the route after the `/chat` route (before the `/chat/relay` route):

```typescript
app.post("/summarize", async (c) => {
  let body: SummarizeRequest;
  try {
    body = await c.req.json<SummarizeRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const model = body.model || defaultModel;
  if (!model || !body.messages) {
    return c.json({ error: "model and messages are required" }, 400);
  }

  const sessionId = v7();
  log("I", sessionId, "summarize_start", `model=${model}`);

  // Use the underlying provider harness directly (no agent loop, no tools)
  const providerHarness = config?.providerHarness ?? createGeneratorHarness();

  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({
          type: "connected",
          sessionId,
          sourceIds: body.sourceIds,
        }),
      });

      const summaryMessages: Message[] = [
        {
          role: "system",
          content:
            "Summarize the following conversation concisely. Preserve key decisions, conclusions, and important details. Output only the summary, no preamble.",
        },
        {
          role: "user",
          content: body.messages
            .map((m) => {
              const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
              return `[${m.role}]: ${content ?? ""}`;
            })
            .join("\n"),
        },
      ];

      for await (const event of providerHarness.invoke({
        model,
        messages: summaryMessages,
      })) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(
            event.type === "error"
              ? { type: "error", runId: event.runId, message: event.error.message }
              : event,
          ),
        });
      }
    } catch (error) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      log("I", sessionId, "summarize_end");
    }
  });
});
```

This requires adding `providerHarness` to `AppConfig`:

```typescript
export interface AppConfig {
  harness?: GeneratorHarnessModule;
  providerHarness?: GeneratorHarnessModule; // raw provider (no agent loop) for summarize
  tools?: ToolDefinition[];
  defaultModel?: string;
  skillDirs?: string[];
}
```

And updating the test to pass the provider harness:

```typescript
const app = await createApp({ harness: agentHarness, providerHarness });
```

**Step 4: Run test to verify it passes**

Run: `bun test server/summarize.test.ts`
Expected: PASS

**Step 5: Run all server tests to check for regressions**

Run: `bun test server/models.test.ts`
Expected: PASS (existing tests still pass)

**Step 6: Format and commit**

```bash
bun run format
git add server/index.ts server/summarize.test.ts
git commit -m "feat: add POST /summarize endpoint with streaming SSE"
```

---

### Task 2: Client — `summarizeFromEvents` helper

**Files:**
- Create: `packages/ai/client/summarize.ts`
- Test: `packages/ai/client/__tests__/summarize.test.ts`

**Step 1: Write the failing test**

Create `packages/ai/client/__tests__/summarize.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { summarizeFromEvents } from "../summarize";
import { createGraph, addNode, addEdge } from "../hypergraph/primitives";
import type { ConversationGraph, NodeId } from "../hypergraph/types";
import { walk } from "../hypergraph/walk";

describe("summarizeFromEvents", () => {
  function buildSimpleGraph(): { graph: ConversationGraph; active: Set<NodeId> } {
    let g = createGraph();
    g = addNode(g, { id: "msg_1", kind: "message" });
    g = addNode(g, { id: "msg_2", kind: "message" });
    g = addNode(g, { id: "msg_3", kind: "message" });
    g = addEdge(g, {
      id: "seq:1:2",
      type: "sequence",
      roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
      properties: {},
    });
    g = addEdge(g, {
      id: "seq:2:3",
      type: "sequence",
      roles: { predecessor: ["msg_2"], successor: ["msg_3"] },
      properties: {},
    });
    return { graph: g, active: new Set(["msg_1", "msg_2", "msg_3"]) };
  }

  it("creates summary node and wires it into graph", () => {
    const { graph, active } = buildSimpleGraph();
    const result = summarizeFromEvents(graph, active, ["msg_1", "msg_2"], "Summary of msgs 1-2");

    // Source nodes removed, summary added
    expect(result.active.has("msg_1")).toBe(false);
    expect(result.active.has("msg_2")).toBe(false);
    expect(result.active.size).toBe(2); // summary + msg_3

    // Walk should include summary then msg_3
    const walked = [...walk(result.graph, result.active)].map((n) => n.id);
    expect(walked.length).toBe(2);
    expect(walked[1]).toBe("msg_3");
    // First should be the summary node
    expect(walked[0]).not.toBe("msg_1");
    expect(walked[0]).not.toBe("msg_2");
  });

  it("returns the summary node id", () => {
    const { graph, active } = buildSimpleGraph();
    const result = summarizeFromEvents(graph, active, ["msg_2"], "Summary of msg 2");
    expect(result.summaryNodeId).toBeDefined();
    expect(result.active.has(result.summaryNodeId)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/__tests__/summarize.test.ts`
Expected: FAIL — module not found

**Step 3: Implement**

Create `packages/ai/client/summarize.ts`:

```typescript
import { v7 } from "uuid";
import type { ConversationGraph, NodeId } from "./hypergraph/types";
import { summarize } from "./hypergraph/operations";

/**
 * Given collected summary text from the /summarize SSE stream,
 * wire it into the conversation graph using operations.summarize().
 *
 * Returns the updated graph, active set, and the new summary node ID.
 */
export function summarizeFromEvents(
  graph: ConversationGraph,
  active: Set<NodeId>,
  sourceIds: NodeId[],
  summaryText: string,
): { graph: ConversationGraph; active: Set<NodeId>; summaryNodeId: NodeId } {
  const summaryNodeId = `summary:${v7()}` as NodeId;
  const summaryNode = { id: summaryNodeId, kind: "message" as const };

  const result = summarize(graph, active, sourceIds, summaryNode);

  return {
    graph: result.graph,
    active: result.active,
    summaryNodeId,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/__tests__/summarize.test.ts`
Expected: PASS

**Step 5: Format and commit**

```bash
bun run format
git add packages/ai/client/summarize.ts packages/ai/client/__tests__/summarize.test.ts
git commit -m "feat: add summarizeFromEvents client helper"
```

---

### Task 3: Integration — end-to-end test

**Files:**
- Modify: `server/summarize.test.ts` (add integration test)

**Step 1: Write the integration test**

Add to `server/summarize.test.ts`:

```typescript
it("uses defaultModel when model is not provided", async () => {
  const providerHarness = createDeterministicHarness({
    responses: [{ events: [{ type: "text", content: "Summary." }] }],
    models: ["default-model"],
  });
  const agentHarness = createAgentHarness({ harness: providerHarness });
  const app = await createApp({
    harness: agentHarness,
    providerHarness,
    defaultModel: "default-model",
  });

  const response = await app.request("/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      sourceIds: ["msg_1"],
    }),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
});
```

**Step 2: Run all tests**

Run: `bun test server/summarize.test.ts packages/ai/client/__tests__/summarize.test.ts`
Expected: PASS

**Step 3: Format and commit**

```bash
bun run format
git add server/summarize.test.ts
git commit -m "test: add defaultModel integration test for /summarize"
```
