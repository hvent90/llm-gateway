# LLM Gateway

An agent framework built on three simple ideas: a harness yields events, harnesses compose, and the events form a graph.

_Point your friendly coding agent to this repo and ask if LLM Gateway is right for you_

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hvent90/llm-gateway)

## Use Cases

The components are composable — pick what you need:

<details>
<summary><strong>Stream an LLM call</strong></summary>

A provider harness ([`zen`](packages/ai/harness/providers/zen.ts), [`anthropic`](packages/ai/harness/providers/anthropic.ts), [`openai`](packages/ai/harness/providers/openai.ts), or [`openrouter`](packages/ai/harness/providers/openrouter.ts)) is all you need:

```typescript
import { createGeneratorHarness } from "./packages/ai/harness/providers/zen";

const harness = createGeneratorHarness();

for await (const event of harness.invoke({
  model: "glm-4.7",
  messages: [{ role: "user", content: "What is the sum of the first 10 primes?" }],
})) {
  if (event.type === "reasoning") process.stderr.write(event.content); // thinking
  if (event.type === "text") process.stdout.write(event.content);
}
```

</details>

<details>
<summary><strong>Single agent with tool calling</strong></summary>

Wrap a provider with [`createAgentHarness`](packages/ai/harness/agent.ts) to get an agentic loop. Add your own tools or use the built-in [`bash`](packages/ai/tools/bash.ts) and [`agent`](packages/ai/tools/agent.ts):

```typescript
import { createAgentHarness } from "./packages/ai/harness/agent";
import { createGeneratorHarness } from "./packages/ai/harness/providers/zen";
import { bashTool } from "./packages/ai/tools";

const agent = createAgentHarness({ harness: createGeneratorHarness() });

for await (const event of agent.invoke({
  model: "glm-4.7",
  messages: [{ role: "user", content: "List the files in this directory" }],
  tools: [bashTool],
  permissions: { allowlist: [{ tool: "bash" }] },
})) {
  if (event.type === "reasoning") process.stderr.write(event.content);
  if (event.type === "text") process.stdout.write(event.content);
  if (event.type === "tool_call") console.log(`\n[calling ${event.name}]`);
  if (event.type === "tool_result") console.log(`[result]`, event.output);
}
```

</details>

<details>
<summary><strong>Multi-agent with human-in-the-loop approval</strong></summary>

The [`AgentOrchestrator`](packages/ai/orchestrator.ts) manages concurrent agents and pauses them on [`permission`](packages/ai/permissions.ts) relays until a human decides:

```typescript
import { AgentOrchestrator } from "./packages/ai/orchestrator";
import { createAgentHarness } from "./packages/ai/harness/agent";
import { createGeneratorHarness } from "./packages/ai/harness/providers/zen";
import { bashTool, agentTool } from "./packages/ai/tools";

const orchestrator = new AgentOrchestrator(
  createAgentHarness({ harness: createGeneratorHarness() }),
);

orchestrator.spawn({
  model: "glm-4.7",
  messages: [{ role: "user", content: "Refactor the auth module" }],
  tools: [bashTool, agentTool],
});

for await (const { agentId, event } of orchestrator.events()) {
  if (event.type === "relay") {
    // Pause here — ask the user, then resume
    orchestrator.resolveRelay(event.id, { approved: true, always: true });
  }
  if (event.type === "text") process.stdout.write(event.content);
}
```

</details>

<details>
<summary><strong>Client-side conversation rendering</strong></summary>

Use the [`graph`](packages/ai/client/graph.ts) and [`projection`](packages/ai/client/projections/thread.ts) without any server dependency — just feed events from whatever source you have:

```typescript
import {
  createInitialConversation, reduceConversation,
  projectThread,
  createSSETransport, createHTTPTransport,
} from "./packages/ai/client";

const sse = createSSETransport({ baseUrl: "/api" });
const http = createHTTPTransport({ baseUrl: "/api" });

let state = createInitialConversation();

for await (const event of sse.stream({ model: "glm-4.7", messages })) {
  state = reduceConversation(state, event);
  const view = projectThread(state.graph);
  render(view); // ViewNode[] — your UI takes it from here
}

// When a permission relay arrives, resolve it over HTTP:
for (const relay of state.pendingRelays) {
  await http.resolveRelay(state.sessionId!, relay.relayId, { approved: true });
}
```

</details>

<details>
<summary><strong>Full product stack</strong></summary>

The [`server`](server/index.ts) wires together the orchestrator, harnesses, and tools behind SSE endpoints. The [`client library`](packages/ai/client/) consumes them:

```typescript
import { createApp } from "./server";
import { createAgentHarness } from "./packages/ai/harness/agent";
import { createGeneratorHarness } from "./packages/ai/harness/providers/zen";
import { bashTool, agentTool } from "./packages/ai/tools";

const app = createApp({
  harness: createAgentHarness({ harness: createGeneratorHarness() }),
  tools: [bashTool, agentTool],
  defaultModel: "glm-4.7",
});

export default { port: 4000, fetch: app.fetch };
```

Then talk to it from a CLI:

```typescript
import { createSSETransport, createHTTPTransport } from "./packages/ai/client";

const sse = createSSETransport({ baseUrl: "http://localhost:4000" });
const http = createHTTPTransport({ baseUrl: "http://localhost:4000" });

const prompt = (q: string) => {
  process.stdout.write(q);
  for await (const line of console) return line;
};

let sessionId: string | null = null;

while (true) {
  const input = await prompt("\n> ");
  if (!input) continue;

  for await (const event of sse.stream({
    model: "glm-4.7",
    messages: [{ role: "user", content: input }],
  })) {
    if (event.type === "connected") sessionId = event.sessionId;
    if (event.type === "reasoning") process.stderr.write(event.content);
    if (event.type === "text") process.stdout.write(event.content);
    if (event.type === "tool_call") console.log(`\n[${event.name}]`);
    if (event.type === "relay" && sessionId) {
      const answer = await prompt(`Allow ${event.tool}? [y/n/always] `);
      const always = answer === "always";
      const approved = always || answer === "y";
      await http.resolveRelay(sessionId, event.id, { approved, always });
    }
  }
  console.log();
}
```

</details>

<details>
<summary><strong>Write your own agent</strong></summary>

The built-in `createAgentHarness` handles tools, permissions, and subagents. But the pattern is simple enough to write yourself — it's a while loop around a provider harness:

```typescript
import { createGeneratorHarness } from "./packages/ai/harness/providers/zen";
import type { GeneratorHarnessModule, GeneratorInvokeParams, HarnessEvent, Message } from "./packages/ai/types";

function createMyCoolAgent(provider: GeneratorHarnessModule): GeneratorHarnessModule {
  return {
    async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const messages: Message[] = [...params.messages];

      while (true) {
        const toolCalls = [];

        // One LLM call — yield events as they stream
        for await (const event of provider.invoke({ ...params, messages })) {
          yield event;
          if (event.type === "tool_call") toolCalls.push(event);
        }

        // No tool calls — agent is done
        if (toolCalls.length === 0) return;

        // Execute tools, feed results back, loop
        for (const tc of toolCalls) {
          const result = await executeMyTool(tc.name, tc.input);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
      }
    },
    supportedModels: () => provider.supportedModels(),
  };
}

const agent = createMyCoolAgent(createGeneratorHarness());
```

</details>

## Concepts

<details>
<summary><strong>The Harness</strong></summary>

The fundamental primitive is the harness — an async generator that takes a prompt and yields events:

```typescript
interface GeneratorHarnessModule {
  invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent>;
}
```

A `HarnessEvent` is a discriminated union: `text`, `reasoning`, `tool_call`, `tool_result`, `error`, `usage`, and a few lifecycle/control variants. Every event carries a `runId` (which run produced it) and an optional `parentId` (which run spawned this one).

That's the entire interface. A provider harness for Zen, Anthropic, or OpenRouter implements this by making one API call and yielding streamed deltas. It knows nothing about tool execution, looping, or permissions.

</details>

<details>
<summary><strong>Harnesses Compose</strong></summary>

A harness that takes another harness as input and returns the same interface is how behavior layers on:

```typescript
createAgentHarness({ harness: createGeneratorHarness() })
// input: GeneratorHarnessModule
// output: GeneratorHarnessModule
```

The agent harness wraps a provider harness and adds an agentic loop — call the inner harness, check permissions on any tool calls, execute approved tools, feed results back as messages, call the inner harness again. From the outside it's still just `invoke() → AsyncIterable<HarnessEvent>`. The consumer doesn't know or care how many LLM round-trips happened inside.

This is the composition pattern. Any harness can wrap any other harness. A logging harness, a caching harness, a rate-limiting harness — they all take a `GeneratorHarnessModule` and return one.

</details>

<details>
<summary><strong>Events Form a Graph</strong></summary>

Because every event carries `runId` and `parentId`, a flat stream of events naturally forms a directed acyclic graph without any explicit graph construction. Sequential events within a run are connected by their shared `runId`. When an agent spawns a subagent, the child's events carry the parent's `runId` as `parentId` — creating a cross-run edge.

```
user message
  └─ agent run (text, tool_call, tool_result, text, ...)
       └─ subagent run (text, tool_call, tool_result, text, ...)
       └─ subagent run (text, ...)
```

On the client, events are reduced into an immutable `Graph` via a pure function:

```typescript
graph = reduceEvent(graph, event);
```

Each event becomes a `Node`. Edges are derived from `runId` continuations and `parentId` links. The graph is the source of truth for the entire conversation.

</details>

<details>
<summary><strong>The Graph Can Be Projected</strong></summary>

A graph of fine-grained nodes (every text delta, every tool call, every lifecycle event) isn't what you render. You project it:

```typescript
const view: ViewNode[] = projectThread(graph);
```

`projectThread` walks the graph and produces a flat list of `ViewNode`s where:

- Consecutive text deltas are merged into single blocks
- Tool results are attached back to their tool calls
- Subagent runs become nested `branches` arrays on the parent's tool call
- Structural nodes (harness lifecycle, usage) are filtered out
- Streaming status is derived from which lifecycle nodes exist

Different projections can walk the same graph differently. `projectThread` gives you a threaded chat view. A timeline projection, a token-usage summary, or a tool-call audit log would all read the same graph.

</details>

<details>
<summary><strong>Primitives</strong></summary>

Everything above is built on a few async coordination primitives:

- **Passthrough** — bridges push-based event production with pull-based async iteration. Used to pipe subagent events into the multiplexer.
- **Deferred** — externalizes a promise's `resolve`/`reject`. Used for permission relays: the agent yields a relay event carrying `resolve`, then `await`s the promise until a human decides.
- **Multiplexer** — races multiple agents' async iterables via `Promise.race()` with a wakeup mechanism that prevents deadlocks when subagents are spawned mid-race.

</details>

<details>
<summary><strong>Permissions</strong></summary>

Tool execution is gated by glob-pattern matching (picomatch). An `allowlist` auto-approves, `allowOnce` is consumed on match, and `deny` vetoes immediately. Unmatched calls pause the agent and yield a `relay` event to the consumer for human decision. If approved with "always", the tool's `derivePermission()` generates a reusable pattern rule.

</details>

## Stack

| Tool | Purpose |
|------|---------|
| Bun | Runtime & package manager |
| Hono | Web framework |
| Effect | Error handling & retries |
| oxfmt | Formatting |

## What's Included

**Provider harnesses:** Zen, Anthropic, OpenAI, OpenRouter — each a thin streaming adapter behind the same `GeneratorHarnessModule` interface.

**Agent harness:** Wraps any provider harness with an agentic tool-calling loop, permission checks, and subagent spawning.

**Built-in tools:** `bash` (shell execution with glob-based permission derivation), `agent` (spawn a subagent with a task).

**Server:** Hono app with SSE streaming for chat (`POST /chat`), relay resolution (`POST /chat/relay/:relayId`), and model listing. Manages per-session orchestrator instances with automatic cleanup.

**Client library:** SSE and HTTP transports, immutable graph reducer, conversation state reducer, and a `projectThread` projection for rendering threaded chat with nested subagent branches.

**Async primitives:** `Deferred`, `AsyncQueue`, `Passthrough`, and `AgentMultiplexer` — the coordination layer that makes concurrent multi-agent streaming work.

## Setup

```bash
bun install
cp .env.example .env
```

Configure your provider API keys in `.env`.

## Development

```bash
bun run dev:server  # Start dev server
bun run dev:web     # Start web client (Vite)
bun run dev:cli     # Run CLI client
bun test            # Run tests
bun run format      # Format code (oxfmt)
```
