# Server

## WHY

HTTP/SSE API layer exposing the agent orchestrator to clients. Manages per-session orchestrators with automatic cleanup.

## WHAT

**Main module: `index.ts`**

- `createApp(config?)` — factory accepting optional harness, tools, defaultModel, skillDirs
- Routes:
  - `GET /models` — returns available models from harness + optional defaultModel
  - `POST /chat` — creates orchestrator, spawns agent, streams events as SSE
  - `POST /chat/relay/:relayId` — resolves pending permission relay for session
- Default tools: agentTool, bashTool, readTool, patchTool (index.ts:9)
- Default harness: agent harness wrapping zen provider (index.ts:56)
- Skills: auto-discovered from skillDirs, injected as system prompt (index.ts:58-59)

**Event serialization:**

- `serializeEvent()` at index.ts:40 — strips Error objects to `{ message }`, adds agentId
- SSE stream sequence: "connected" event first (with sessionId), then all harness events

**Session management:**

- Map<sessionId, AgentOrchestrator> stored in createApp closure (index.ts:62)
- Orchestrators cleaned up when stream ends (index.ts:129)
- Relay resolution: client POSTs to /chat/relay/:relayId with sessionId + response

## HOW

```bash
bun run dev:server  # starts with hot reload
```

Each POST /chat creates a fresh AgentOrchestrator for that session. SSE events flow from orchestrator.events() until stream closes or error occurs.

## Tests

- `index.test.ts` — server integration tests
- `models.test.ts` — model endpoint tests

## API Reference

See `docs/api.md` for full endpoint documentation.
