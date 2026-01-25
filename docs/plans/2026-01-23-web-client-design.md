# Web Client Design

Validation web client for the LLM Gateway harness and API.

## Technology Stack

| Layer       | Technology          |
| ----------- | ------------------- |
| Runtime     | Bun                 |
| Build       | Vite                |
| Framework   | React               |
| Components  | Base UI             |
| Styling     | Tailwind CSS        |
| State/Async | Effect + @effect/rx |
| Formatting  | oxfmt               |

## Project Structure

```
clients/web/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── src/
│   ├── main.tsx              # Entry point
│   ├── App.tsx               # Root component, providers
│   ├── components/           # UI components
│   ├── services/             # Effect services (API, SSE)
│   ├── state/                # Rx stores
│   └── types.ts              # Shared types
└── public/
```

**Commands** (root package.json):

- `bun run web` → `cd clients/web && bunx vite`
- `bun run web:build` → `cd clients/web && bunx vite build`

## UI Layout

```
┌──────────────────────────────────────────────────────────┐
│  LLM Gateway                                             │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Conversation Thread (scrollable)                        │
│  ┌────────────────────────────────────────────────────┐  │
│  │ You: What files are in src/?                       │  │
│  │                                                    │  │
│  │ Agent-1:                                           │  │
│  │   💭 Let me check the directory...                 │  │
│  │   🔧 list_files: {"path": "src/"}                  │  │
│  │      ↳ ["index.ts", "server.ts"]                   │  │
│  │   The src/ directory contains index.ts and...     │  │
│  │                                                    │  │
│  │   ├─ Agent-2 (subagent):                          │  │
│  │   │    I'll analyze index.ts...                   │  │
│  │   │    🔧 read_file: {"path": "src/index.ts"}     │  │
│  │   │    ⚠️ Permission required: read_file          │  │
│  │   │    [Allow] [Allow All] [Deny]                 │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  > Type your message...                         [Send]   │
└──────────────────────────────────────────────────────────┘
```

- Single in-memory conversation (page refresh clears)
- Model configured via `LLM_MODEL` environment variable

## Component Structure

```
App
├── Header                      # Title bar
├── ConversationThread          # Scrollable message area
│   └── MessageNode             # Recursive component for nested agents
│       ├── UserMessage         # "You: ..."
│       └── AgentMessage        # Agent response with all event types
│           ├── ReasoningBlock  # 💭 dimmed reasoning
│           ├── ToolCallBlock   # 🔧 tool name + input
│           │   └── ToolResult  # ↳ output
│           ├── TextContent     # Streamed text
│           ├── PermissionPrompt # [Allow] [Allow All] [Deny]
│           └── MessageNode[]   # Recursive children (subagents)
└── InputArea                   # Text input + send button
```

**Base UI Components:**

- `@base-ui/react/input` - Text input
- `@base-ui/react/button` - Send and permission buttons
- `@base-ui/react/scroll-area` - Conversation thread

## State Management

```ts
// state/conversation.ts
interface ConversationState {
  messages: MessageNode[];
  isStreaming: boolean;
  pendingPermission: PermissionRequest | null;
}

interface MessageNode {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string[];
  toolCalls: ToolCall[];
  children: MessageNode[];
}
```

## SSE Streaming

```ts
// services/chat.ts
const sendMessage = (content: string, permissions: Permission[]) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post("/chat", {
      body: { messages, permissions },
    });

    return yield* response.stream.pipe(
      Stream.decodeText,
      parseSSE,
      Stream.tap((event) => Rx.set(conversationStore, handleEvent(event))),
    );
  });
```

**Event Handling:**

| Event                 | Action                                      |
| --------------------- | ------------------------------------------- |
| `text`                | Append to current agent's content           |
| `reasoning`           | Append to reasoning array                   |
| `tool_call`           | Add to toolCalls array                      |
| `tool_result`         | Attach result to matching tool_call         |
| `permission_required` | Set pendingPermission, pause for user input |
| `error`               | Display error, re-enable input              |
| `done`                | Clear isStreaming, re-enable input          |

## Permission Handling

Permissions sent upfront with request to avoid round trips:

```ts
POST /chat {
  messages: [...],
  permissions: ["read_file", "list_files"]
}
```

**Permission Actions:**

| Button    | Behavior                                         |
| --------- | ------------------------------------------------ |
| Allow     | Grant one-time permission for this specific call |
| Allow All | Add to granted set, include in future requests   |
| Deny      | Reject the tool call                             |

Server only emits `permission_required` for tools not in the permissions array.

## Testing

**Development:**

```bash
# Terminal 1: Gateway server
bun run dev

# Terminal 2: Web client
bun run web
```

Vite proxies `/chat` to gateway server.

**Validation Checklist:**

- [ ] Text streaming renders incrementally
- [ ] Reasoning appears dimmed with 💭
- [ ] Tool calls show name + input
- [ ] Tool results appear nested under calls
- [ ] Permission prompt appears and blocks until resolved
- [ ] Allow All prevents future prompts for same tool
- [ ] Subagent messages render nested under parent
- [ ] Input disabled during streaming
- [ ] Errors display and re-enable input
