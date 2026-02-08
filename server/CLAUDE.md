# Server

## WHY

HTTP/SSE API layer exposing the agent orchestrator to clients. Manages per-session orchestrators with automatic cleanup.

## WHAT

**Main module: `index.ts`**

- `createApp(config?)` — factory accepting optional harness, tools, defaultModel, skillDirs
- Routes: `GET /models`, `POST /chat` (SSE stream), `POST /chat/relay/:relayId` (permission resolution)
- Default tools: agentTool, bashTool, readTool, patchTool
- Per-session orchestrator lifecycle: created on POST /chat, cleaned up when stream ends

See also: `packages/ai/CLAUDE.md` for the orchestrator and harness internals.

## HOW

```bash
bun run dev:server  # starts with hot reload
```

Each POST /chat creates a fresh AgentOrchestrator for that session. SSE events flow from orchestrator.events() until stream closes or error occurs.

## Tests

- `index.test.ts` — server integration tests
- `models.test.ts` — model endpoint tests

## API Reference

See root `docs/api.md` for full endpoint documentation.
