# CLI Client

## WHY

Terminal-based chat client with rich TUI rendering. Uses SolidJS fine-grained reactivity for efficient streaming updates without full redraws.

## WHAT

**Single file:** `index.tsx` (~300 lines)

**Stack:** SolidJS + @opentui/solid (optional peer dependency)

Three components: `ChatApp` (state management + layout), `ThreadView` (flat thread renderer using `projectThread()`), `ContentView` (ViewContent kind renderer). Uses SolidJS fine-grained reactivity so streaming updates re-render only changed DOM nodes. Subagent branches rendered via `BranchView` with terminal indentation.

Uses `reduceConversation`, `projectThread`, `projectMessages` from `packages/ai/client/hypergraph`, and transports from `packages/ai/client`.

## HOW

```bash
bun run dev:cli  # needs .env with API key
```

**Config:** SERVER_URL and DEFAULT_MODEL from environment.
