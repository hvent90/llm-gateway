# CLI Client Implementation Plan

Connect the CLI client to the server's `/chat` endpoint with full interactive TUI.

## Target Layout

```
┌─────────────────────────────────────┐
│ LLM Gateway CLI                     │
├─────────────────────────────────────┤
│ [Conversation history - scrollable] │
│                                     │
│ You: What is 2+2?                   │
│                                     │
│ 💭 Let me calculate...              │
│ The answer is 4.                    │
│                                     │
├─────────────────────────────────────┤
│ > Type your message... [Enter]      │
└─────────────────────────────────────┘
```

## Tasks

### 1. Add text input component
- Add `TextInputRenderable` (or equivalent from OpenTUI) at bottom of layout
- Capture keystrokes for typing
- Submit on Enter key
- Disable during streaming, re-enable after response completes

### 2. Implement conversation state
```ts
interface ConversationState {
  messages: Message[];           // For API requests (OpenAI format)
  isStreaming: boolean;          // Disable input while streaming
}
```

### 3. Implement SSE client
- On submit: POST to `${serverUrl}/chat` with `{model, messages}`
- Use fetch with streaming body reader
- Parse SSE format: `event: <type>\ndata: <json>\n\n`
- Route parsed events to `handleEvent()`

### 4. Implement event rendering
Display each event type in the conversation view:

| Event Type | Display Format |
|------------|----------------|
| `text` | Append content inline (streaming) |
| `reasoning` | `💭 {content}` (dimmed if possible) |
| `tool_call` | `🔧 {name}: {input}` |
| `tool_result` | `   ↳ {output}` |
| `error` | `❌ Error: {message}` |

### 5. Multi-turn conversation
- Maintain `messages` array for API context
- After user submits: add `{role: "user", content: prompt}` to messages
- After response completes: add `{role: "assistant", content: fullResponse}` to messages
- Display "You: {prompt}" before streaming starts

### 6. Configuration
- Model: `process.env.LLM_MODEL ?? "nvidia/nemotron-nano-9b-v2:free"`
- Server URL: `process.env.LLM_GATEWAY_URL ?? "http://localhost:3000"`

## Event Types (from server)

```ts
// From packages/ai/types.ts
type HarnessEvent =
  | { type: "text"; runId: string; id: string; content: string }
  | { type: "reasoning"; runId: string; id: string; content: string }
  | { type: "tool_call"; runId: string; id: string; name: string; input: unknown }
  | { type: "tool_result"; runId: string; id: string; output: unknown }
  | { type: "error"; runId: string; message: string }
```

## SSE Parsing

Server sends:
```
event: text
data: {"type":"text","runId":"...","id":"...","content":"Hello"}

event: text
data: {"type":"text","runId":"...","id":"...","content":" world"}
```

Parse with:
```ts
// Split chunks by \n\n, extract event/data lines
const lines = chunk.split('\n');
let eventType = '';
let data = '';
for (const line of lines) {
  if (line.startsWith('event: ')) eventType = line.slice(7);
  if (line.startsWith('data: ')) data = line.slice(6);
}
if (data) handleEvent(JSON.parse(data));
```

## Files to Modify

- `clients/cli/index.ts` - Main implementation

## Testing

1. Start server: `bun run dev`
2. Start CLI: `bun run cli`
3. Type a prompt, press Enter
4. Verify streaming response appears
5. Send follow-up message to test multi-turn
