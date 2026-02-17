# Web Client

## WHY

Browser-based chat UI for interacting with agents. Provides threaded conversation rendering, DAG graph visualization, permission approval dialogs, and model/mode selection.

## WHAT

**Stack:** Vite + React + TailwindCSS + streamdown

- `App.tsx` — Main app: hypergraph conversation state, SSE streaming with RAF batching, permission relay handling, model selection, agent/rlm mode toggle, chat/graph view toggle
- `ConversationThread.tsx` — Renders `projectThread()` output as grouped conversation bubbles with collapsible tool calls, subagent branches, and permission prompts. Uses `streamdown` for markdown rendering.
- `GraphView.tsx` — DAG visualization using SVG. Projects hypergraph via `projectDAG()`, renders block nodes, edges, and group bounding boxes. Supports pan/zoom via `usePanZoom` hook.
- `InputArea.tsx` — Chat input with model selector dropdown and agent/rlm mode toggle
- `ErrorBoundary.tsx` — React error boundary
- `types.ts` — Re-exports from `packages/ai/client/hypergraph` and `packages/ai/client/server-event`

Uses `reduceConversation`, `createInitialConversation`, `projectMessages`, `projectThread` from `packages/ai/client/hypergraph`, and transports from `packages/ai/client`.

## HOW

```bash
bun run dev:web   # starts Vite dev server
bun run build:web # production build
```

**Chat view:** User submits message → added to hypergraph → messages projected for API → SSE stream started → events batched to RAF → relay events handled via permission dialogs (allow/always/deny).

**Graph view:** Same hypergraph state → `projectDAG()` produces deterministic layout with block nodes, edges, and groups → SVG renders nodes (`DAGNode`), edges (`DAGEdge`), and group bounding boxes (`DAGGroup`). Pan/zoom via `usePanZoom` hook.
