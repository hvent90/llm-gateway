# Web Client

## WHY

Browser-based chat UI for interacting with agents. Provides visual conversation rendering, permission approval dialogs, and model selection.

## WHAT

**Stack:** Vite + React + TailwindCSS

**Main module: `src/App.tsx`**

- ConversationState management via `reduceConversation()` from packages/ai/client (App.tsx:10)
- SSE streaming with requestAnimationFrame batching (App.tsx:49-79)
- Permission relay approval: allow / allow-all / deny (App.tsx:107-165)
- Model selection via GET /models endpoint (App.tsx:30-42)

**Components:**

- `ConversationThread.tsx` — renders thread projection as conversation bubbles
- `InputArea.tsx` — chat input with model selector dropdown

**Transports:**

Uses `createSSETransport` and `createHTTPTransport` from packages/ai/client (App.tsx:6-14)

**RAF batching:**

During streaming, state updates are batched to animation frames to avoid excessive re-renders. Pending events accumulate in an array and flush on next frame (App.tsx:49-63).

## HOW

```bash
bun run dev:web   # starts Vite dev server
bun run build:web # production build
```

Connects to server at configurable base URL (default: same origin).

When user submits message:
1. Adds user message to graph via reduceConversation
2. Projects messages from graph via projectMessages
3. Starts SSE stream with model + messages + permissions
4. Batches incoming events to RAF for efficient rendering
5. Handles relay events via permission handlers (allow/allow-all/deny)
