# Web Client

## WHY

Browser-based chat UI for interacting with agents. Provides visual conversation rendering, permission approval dialogs, and model selection.

## WHAT

**Stack:** Vite + React + TailwindCSS

- `App.tsx` — Main app: conversation state, SSE streaming with RAF batching, permission relay handling, model selection
- `ConversationThread.tsx` — Renders thread projection as conversation bubbles
- `InputArea.tsx` — Chat input with model selector dropdown

Uses `reduceConversation`, `projectThread`, transports from `packages/ai/client` (see `packages/ai/client/CLAUDE.md`).

## HOW

```bash
bun run dev:web   # starts Vite dev server
bun run build:web # production build
```

User submits message → added to graph → messages projected for API → SSE stream started → events batched to RAF → relay events handled via permission dialogs (allow/allow-all/deny).
