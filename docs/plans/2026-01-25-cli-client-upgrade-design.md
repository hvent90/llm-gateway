# CLI Client Upgrade Design

Bring the CLI client up to spec with the backend and web client after the callback-to-AsyncGenerator streaming migration.

## Overview

The CLI client needs these changes to match the backend/web client:

| Current CLI | Updated CLI |
|-------------|-------------|
| No session tracking | sessionId from server |
| 5 event types | 7 event types |
| No permission handling | Interactive prompts |
| Inline SSE parsing | Extracted chat service |
| Simple Message type | Full Message union |

## New State

```typescript
interface ConversationState {
  messages: Message[];
  isStreaming: boolean;
  currentAssistantContent: string;
  isInReasoning: boolean;
  sessionId: string | null;                    // NEW
  pendingPermission: PermissionRequest | null; // NEW
  grantedTools: Set<string>;                   // NEW
}
```

## Types

Updated `ServerEvent` type (matching web client):

```typescript
type ServerEvent =
  | { type: "connected"; sessionId: string }
  | { type: "text"; runId: string; id: string; agentId: string; parentId?: string; content: string }
  | { type: "reasoning"; runId: string; id: string; agentId: string; parentId?: string; content: string }
  | { type: "tool_call"; runId: string; id: string; agentId: string; parentId?: string; name: string; input: unknown }
  | { type: "tool_result"; runId: string; id: string; agentId: string; parentId?: string; name: string; output: unknown }
  | { type: "error"; runId: string; agentId: string; parentId?: string; message: string }
  | { type: "permission_required"; runId: string; id: string; agentId: string; parentId?: string; toolCallId: string; tool: string; params: Record<string, unknown> };
```

New `PermissionRequest` type:

```typescript
interface PermissionRequest {
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}
```

## Chat Service

Extract SSE streaming to `clients/cli/chat.ts`, mirroring the web client's approach:

```typescript
export interface ChatRequest {
  model: string;
  messages: Message[];
  permissions?: Permissions;
}

export async function* streamChat(
  serverUrl: string,
  request: ChatRequest,
): AsyncGenerator<ServerEvent> {
  // SSE streaming logic
}

export async function resolvePermission(
  serverUrl: string,
  sessionId: string,
  toolCallId: string,
  approved: boolean,
  reason?: string,
): Promise<boolean> {
  const response = await fetch(`${serverUrl}/chat/permission/${toolCallId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, approved, reason }),
  });
  return response.ok;
}
```

Key differences from web client:
- Takes `serverUrl` as parameter (CLI uses env var, not relative paths)
- Same async generator pattern for streaming
- Same permission resolution endpoint

## Permission Prompt UI

Inline component in conversation when permission is required:

```
┌─────────────────────────────────────────────────────────┐
│ ⚠️  Permission Required                                 │
│                                                         │
│ Tool: bash                                              │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ { "command": "ls -la /home" }                       │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│  [1] Allow    [2] Allow All    [3] Deny                │
│      ▲                                                  │
└─────────────────────────────────────────────────────────┘
```

### Keyboard handling

- `1` / `a` - Allow (this invocation only)
- `2` / `A` - Allow All (add tool to grantedTools set)
- `3` / `d` - Deny
- `←` `→` / `Tab` - Move focus between buttons
- `Enter` - Select focused button

### Visual states

- Focused button gets highlighted background (green/blue/red matching web colors)
- Unfocused buttons are dimmed
- Yellow/amber border to indicate warning state

### Behavior

- When `permission_required` event arrives, prompt is appended to conversation
- Input field is disabled (ignores keystrokes)
- Keystrokes route to permission prompt
- After resolution, prompt remains visible (read-only) and input re-enables

## Event Handling Flow

```
User submits message
        ↓
streamChat() generator starts
        ↓
First event: "connected" → store sessionId
        ↓
Loop through events:
        │
        ├─ "text" → append to conversation
        ├─ "reasoning" → append (dimmed/italic)
        ├─ "tool_call" → show 🔧 tool: params
        ├─ "tool_result" → show ↳ result
        ├─ "error" → show ❌ message
        │
        └─ "permission_required" →
                ↓
           Set pendingPermission
           Show PermissionPrompt inline
           Disable input field
           Wait for user decision...
                ↓
           User presses 1/2/3 or navigates
                ↓
           Call resolvePermission() API
           Clear pendingPermission
           Re-enable input field
                ↓
           Stream continues automatically
           (server resumes after permission resolved)
```

Key insight: The stream stays open. After `resolvePermission()` is called, the server resumes the agent and continues emitting events on the same SSE connection.

## Implementation Plan

### Files to create

- `clients/cli/chat.ts` - streaming and permission resolution functions
- `clients/cli/types.ts` - shared types (ServerEvent, PermissionRequest, etc.)

### Files to modify

- `clients/cli/index.ts` - update CliClient with new state, UI, and event handling

### Implementation order

1. Create types file
2. Create chat service with streamChat generator
3. Add permission prompt UI component to CliClient
4. Add keyboard handling for permission navigation
5. Update state and wire up event handling
6. Test end-to-end with bash tool permission flow
