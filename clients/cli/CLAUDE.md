# CLI Client

## WHY

Terminal-based chat client with rich TUI rendering. Uses SolidJS fine-grained reactivity for efficient streaming updates without full redraws.

## WHAT

**Single file:** `index.tsx` (~350 lines)

**Stack:** SolidJS + @opentui/solid (optional peer dependency)

Three components: `ChatApp` (state management), `NodeView` (recursive graph renderer), `BlockView` (content block rendering). Uses SolidJS fine-grained reactivity so streaming updates re-render only changed DOM nodes.

Uses `reduceConversation`, `projectThread`, transports from `packages/ai/client` (see `packages/ai/client/CLAUDE.md`).

## HOW

```bash
bun run dev:cli  # needs .env with API key
```

**Config:** SERVER_URL and DEFAULT_MODEL from environment.
