# HarnessEvent Reference

All events yielded by harnesses during an invocation. Defined as a union type in `packages/ai/types.ts:77`.

Every event carries `runId: string` (identifies the harness run) and an optional `parentId?: string` (links to the parent run or tool call that spawned it).

## Lifecycle

Provider harnesses (single LLM call) and the agent harness (agentic loop) form a two-layer stack. A typical sequence:

```
agent: harness_start
  provider: text (streamed chunks)
  provider: reasoning (streamed chunks)
  provider: tool_call (one per tool, after stream ends)
  provider: usage
  agent: relay (permission check, pauses until resolved)
  agent: tool_call (re-emitted after approval)
  agent: tool_result (after execution)
  ... (loop continues until no tool calls)
agent: harness_end
```

## Event Types

### `harness_start`
Marks the beginning of an agent harness run. Emitted once at the top of the agentic loop.
- **Emitter:** agent harness (`harness/agent.ts:46`)

### `harness_end`
Marks the end of an agent harness run. Emitted on normal completion, error, or max iterations.
- **Emitter:** agent harness

### `text`
A chunk of streamed text content from the model.
- `id` — stable across chunks belonging to the same text stream
- `content` — the text fragment
- **Emitter:** provider harness (e.g. `harness/providers/zen.ts:249`)
- **Passthrough:** agent harness re-yields with its own `runId`

### `reasoning`
A chunk of streamed reasoning/chain-of-thought content (provider-dependent).
- `id` — stable across chunks of the same reasoning block
- `content` — the reasoning fragment
- **Emitter:** provider harness (e.g. `harness/providers/zen.ts:239`)
- **Passthrough:** agent harness re-yields with its own `runId`

### `tool_call`
The model is requesting a tool invocation.
- `id` — tool call identifier (namespaced as `{agentRunId}/{rawId}` by the agent harness)
- `name` — tool name
- `input` — parsed arguments (or `{ __toolParseError, parseError, rawArguments }` on malformed JSON)
- **Emitter:** provider harness yields raw tool calls after the stream ends; agent harness re-yields approved calls with namespaced IDs

### `tool_result`
Result of executing a tool.
- `id` — matches the `tool_call` id
- `name` — tool name
- `output` — `{ context, result }` on success; `{ status: "denied", reason }` on denial; `{ error }` on failure
- **Emitter:** agent harness only (`harness/agent.ts:268`)

### `usage`
Token usage for one LLM call.
- `inputTokens` — prompt tokens consumed
- `outputTokens` — completion tokens generated
- **Emitter:** provider harness (e.g. `harness/providers/zen.ts:305`)
- **Passthrough:** agent harness re-yields

### `error`
An error occurred (API failure, missing tool executor, tool execution error, etc.).
- `error` — an `Error` instance
- **Emitter:** both layers. Provider harnesses yield on API/stream errors; agent harness yields on tool execution errors or missing executors

### `repl_input`
Code extracted from the model's response, about to be executed in the REPL.
- `code` — the JavaScript code to execute
- `id` — unique ID for this execution span (shared with corresponding `repl_output`)
- **Emitter:** RLM harness only (`rlm/harness.ts`)

### `repl_progress`
Live output streamed during REPL execution (console output, exec streams, metrics).
- `chunk` — the output fragment
- `stream` — `"stdout"` or `"stderr"`
- **Emitter:** RLM harness only (`rlm/harness.ts`)

### `repl_output`
Complete result of a REPL execution. Contains accumulated stdout and completion status.
- `stdout` — full accumulated output
- `error` — error message if execution failed (optional)
- `done` — whether `FINAL()` was called
- `id` — matches the `repl_input` ID
- **Emitter:** RLM harness only (`rlm/harness.ts`)

### `relay` (kind: `"permission"`)
A permission request that pauses the harness until resolved. The harness yields this event and suspends via a deferred promise until `respond()` is called.
- `kind` — always `"permission"` (extensible to other relay kinds)
- `toolCallId` — the namespaced tool call ID
- `tool` — tool name
- `params` — tool arguments
- `respond(response)` — callback to approve (`{ approved: true }`) or deny (`{ approved: false, reason }`)
- **Emitter:** agent harness only (`harness/agent.ts:162`)
