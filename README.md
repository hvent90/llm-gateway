# LLM Gateway

An agent framework built on three simple ideas: a harness yields events, harnesses compose, and the events form a graph.

## The Harness

The fundamental primitive is the harness — an async generator that takes a prompt and yields events:

```typescript
interface GeneratorHarnessModule {
  invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent>;
}
```

A `HarnessEvent` is a discriminated union: `text`, `reasoning`, `tool_call`, `tool_result`, `error`, `usage`, and a few lifecycle/control variants. Every event carries a `runId` (which run produced it) and an optional `parentId` (which run spawned this one).

That's the entire interface. A provider harness for Anthropic or OpenRouter implements this by making one API call and yielding streamed deltas. It knows nothing about tool execution, looping, or permissions.

## Harnesses Compose

A harness that takes another harness as input and returns the same interface is how behavior layers on:

```typescript
createAgentHarness({ harness: createAnthropicHarness() })
// input: GeneratorHarnessModule
// output: GeneratorHarnessModule
```

The agent harness wraps a provider harness and adds an agentic loop — call the inner harness, check permissions on any tool calls, execute approved tools, feed results back as messages, call the inner harness again. From the outside it's still just `invoke() → AsyncIterable<HarnessEvent>`. The consumer doesn't know or care how many LLM round-trips happened inside.

This is the composition pattern. Any harness can wrap any other harness. A logging harness, a caching harness, a rate-limiting harness — they all take a `GeneratorHarnessModule` and return one.

## Events Form a Graph

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

## The Graph Can Be Projected

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

## Primitives

Everything above is built on a few async coordination primitives:

- **Passthrough** — bridges push-based event production with pull-based async iteration. Used to pipe subagent events into the multiplexer.
- **Deferred** — externalizes a promise's `resolve`/`reject`. Used for permission relays: the agent yields a relay event carrying `resolve`, then `await`s the promise until a human decides.
- **Multiplexer** — races multiple agents' async iterables via `Promise.race()` with a wakeup mechanism that prevents deadlocks when subagents are spawned mid-race.

## Permissions

Tool execution is gated by glob-pattern matching (picomatch). An `allowlist` auto-approves, `allowOnce` is consumed on match, and `deny` vetoes immediately. Unmatched calls pause the agent and yield a `relay` event to the consumer for human decision. If approved with "always", the tool's `derivePermission()` generates a reusable pattern rule.

## Stack

| Tool | Purpose |
|------|---------|
| Bun | Runtime & package manager |
| Hono | Web framework |
| Effect | Error handling & retries |
| oxfmt | Formatting |

## Setup

```bash
bun install
cp .env.development .env
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
