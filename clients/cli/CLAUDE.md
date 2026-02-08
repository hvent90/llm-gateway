# CLI Client

## WHY

Terminal-based chat client with rich TUI rendering. Uses SolidJS fine-grained reactivity for efficient streaming updates without full redraws.

## WHAT

**Single file:** `index.tsx` (~350 lines)

**Stack:** SolidJS + @opentui/solid (optional peer dependency)

**Architecture:**

- `ChatApp` component (index.tsx:176) — main app with state management
- `NodeView` component (index.tsx:97) — recursive renderer walking conversation graph
- `BlockView` component (index.tsx:46) — renders individual ContentBlocks (text, tool_call, reasoning)

**Block rendering:**

- Text: plain wrapped text with "You: " prefix for user messages
- Tool calls: `[tool] name: input` with optional `-> output` (index.tsx:62-66)
- Reasoning: dimmed italic text with left border (index.tsx:76-84)
- Errors: red `[error] message` (index.tsx:112-116)
- Relays: yellow permission prompt with y/n instructions (index.tsx:118-128)

**Permission handling:**

Detects 'y'/'n' keypresses when relay pending, resolves via httpTransport.resolveRelay (index.tsx:246-258)

**Scrolling:**

Scrollbox with `stickyScroll stickyStart="bottom"` for auto-scroll to latest message (index.tsx:302)

## HOW

```bash
bun run dev:cli  # needs .env with API key
```

**Config:** SERVER_URL and DEFAULT_MODEL from environment (index.tsx:25-26)

**Event flow:**

1. User submits input → added to conversation graph via reduceConversation
2. buildApiMessages() walks graph to construct API request (index.tsx:140-173)
3. streamChat() consumes SSE events, updates conversation state (index.tsx:225-235)
4. SolidJS fine-grained reactivity re-renders only changed DOM nodes
