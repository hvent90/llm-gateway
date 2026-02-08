# Server API Reference

HTTP/SSE API for the LLM Gateway agent orchestrator. Defined in `server/index.ts`.

## GET /models

Returns available models and optional default.

**Response**

```json
{ "models": ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"], "defaultModel": "openai/gpt-4o" }
```

`defaultModel` is omitted if not configured or not in the model list.

## POST /chat

Starts an agent session and streams events over SSE.

**Request body**

```json
{
  "model": "openai/gpt-4o",
  "messages": [{ "role": "user", "content": "Hello" }],
  "permissions": { "allowlist": ["read:*"] }
}
```

- `model` — required (unless server has a `defaultModel`)
- `messages` — required, array of `{ role, content }` objects
- `permissions` — optional, controls which tools run without approval. Omit to allow all tools; pass `{ "allowlist": [] }` to require approval for every tool call.

**Response** — `text/event-stream` (SSE)

The first event is always `connected` with the session ID:

```
event: connected
data: {"type":"connected","sessionId":"<uuid>"}
```

All subsequent events follow the `ServerEvent` union (defined in `packages/ai/client/server-event.ts`). Every event after `connected` includes an `agentId` field identifying the originating agent.

### SSE Event Types

| Event | Key fields | Description |
|-------|-----------|-------------|
| `connected` | `sessionId` | Session established, provides ID for relay calls |
| `harness_start` | `runId` | Agent run started |
| `text` | `id`, `content` | Streamed text chunk (append by `id`) |
| `reasoning` | `id`, `content` | Streamed reasoning chunk (append by `id`) |
| `tool_call` | `id`, `name`, `input` | Tool invocation (after permission check) |
| `tool_result` | `id`, `name`, `output` | Tool execution result |
| `relay` | `id`, `kind`, `tool`, `params` | Permission request — agent pauses until resolved |
| `usage` | `inputTokens`, `outputTokens` | Token usage for a provider call |
| `error` | `message` | Error (serialized from Error object) |
| `harness_end` | `runId` | Agent run completed |

All events except `connected` carry `runId`, `agentId`, and optional `parentId` (for subagent lineage).

### Streaming text and reasoning

`text` and `reasoning` events stream incrementally. Events with the same `id` should be concatenated to build the full content.

### Permission relay flow

When a tool call requires permission, the stream emits a `relay` event and the agent pauses. The client must approve or deny via `POST /chat/relay/:relayId` to resume execution.

## POST /chat/relay/:relayId

Resolves a pending permission relay, resuming the paused agent.

**URL params**

- `relayId` — the `id` from the `relay` SSE event

**Request body**

```json
{
  "sessionId": "<sessionId from connected event>",
  "response": { "approved": true }
}
```

- `sessionId` — required, ties the relay to the active orchestrator
- `response` — required, the resolution (e.g. `{ "approved": true }` or `{ "approved": false }`)

**Responses**

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{ "success": true }` | Relay resolved, agent resumes |
| 400 | `{ "error": "..." }` | Missing fields |
| 404 | `{ "error": "Session not found" }` | Session expired or invalid |
| 404 | `{ "error": "Relay not found" }` | Relay ID doesn't match any pending relay |

## Session Lifecycle

1. Client sends `POST /chat` — server creates an `AgentOrchestrator` and assigns a `sessionId`
2. Server streams SSE events as the agent runs, starting with `connected`
3. If a `relay` event arrives, the agent pauses until the client calls `POST /chat/relay/:relayId`
4. When the agent finishes (or errors), the stream closes and the orchestrator is cleaned up
5. After stream close, the `sessionId` is no longer valid for relay calls
