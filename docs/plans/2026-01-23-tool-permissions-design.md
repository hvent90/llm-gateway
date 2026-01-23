# Tool Permission System Design

## Overview

A permission system that allows clients to control which tools can be executed, with support for allow-once, allow-always, and deny (with optional reason) responses.

## Key Decisions

| Aspect | Decision |
|--------|----------|
| Permission responses | allow-once, allow-always, deny (with reason) |
| State location | Client-side (sends permissions with each request) |
| Permission check | Server-side in harness, before tool execution |
| When not allowed | Emit `permission_required`, continue checking other tools |
| Stream behavior | All events emitted, then stream closes |
| Denial handling | `tool_result` with `status: "denied"`, agent continues |
| Allowlist structure | Tool name + glob patterns for params |
| API shape | `permissions: { allowlist, allowOnce, deny }` |

## Types

### ToolPermission

```typescript
type ToolPermission = {
  tool: string;                     // tool name (exact match)
  params?: Record<string, string>;  // param name → glob pattern
};
```

Examples:

```typescript
// Allow get_weather with any params
{ tool: "get_weather" }

// Allow bash only for ls commands
{ tool: "bash", params: { command: "ls *" } }

// Allow file_write only to tmp directory
{ tool: "file_write", params: { path: "/tmp/*" } }
```

Matching logic:
- If `params` is omitted, tool is allowed with any parameters
- If `params` is present, each specified param must match its glob
- Unspecified params are allowed (only check what's listed)

### Permissions Object

```typescript
type Permissions = {
  allowlist?: ToolPermission[];    // always allowed
  allowOnce?: ToolPermission[];    // allowed this request only
  deny?: Array<{                   // denied tool calls
    toolCallId: string;
    reason?: string;
  }>;
};
```

### Updated InvokeParams

```typescript
export interface InvokeParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  emit: (event: HarnessEvent) => void;

  context?: {
    runId?: string;
    parentId?: string;
  };

  permissions?: Permissions;
}
```

### New HarnessEvent: permission_required

```typescript
type PermissionRequiredEvent = {
  type: "permission_required";
  runId: string;
  id: string;
  parentId?: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
};
```

## API Request Format

```typescript
type ChatRequest = {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  permissions?: Permissions;
};
```

## Flow

### Initial Request

Client sends request with `allowlist` containing pre-approved tools.

### Permission Required

1. LLM returns tool calls
2. Harness checks each tool call against `allowlist` and `allowOnce`
3. For denied calls (in `deny` list): emit `tool_result` with `status: "denied"`
4. For unpermitted calls: emit `permission_required` event
5. For permitted calls: execute normally
6. Stream closes after all events emitted

### Continuation (Allow Once)

Client prompts user, user approves for this request only:

```typescript
{
  model: "...",
  messages: [...],  // includes previous context
  permissions: {
    allowlist: [...],  // unchanged
    allowOnce: [{ tool: "bash", params: { command: "rm foo.txt" } }]
  }
}
```

### Continuation (Allow Always)

Client prompts user, user approves permanently:

```typescript
{
  model: "...",
  messages: [...],
  permissions: {
    allowlist: [
      ...previousAllowlist,
      { tool: "bash", params: { command: "rm *" } }  // added
    ]
  }
}
```

### Continuation (Deny)

Client prompts user, user denies:

```typescript
{
  model: "...",
  messages: [...],
  permissions: {
    allowlist: [...],
    deny: [{ toolCallId: "call_123", reason: "User doesn't want to delete files" }]
  }
}
```

Denial becomes a `tool_result` with `status: "denied"` - agent continues and can adapt.

## Implementation

### Permission Checking (openrouter.ts)

Before executing each tool:

```typescript
for (const tc of toolCalls) {
  const toolDef = params.tools?.find((t) => t.name === tc.name);

  // Check deny list first
  const denial = params.permissions?.deny?.find(d => d.toolCallId === tc.id);
  if (denial) {
    taggedEmit({
      type: "tool_result",
      runId,
      id: tc.id,
      name: tc.name,
      output: { status: "denied", reason: denial.reason },
    });
    continue;
  }

  // Check if allowed (allowlist or allowOnce)
  const isAllowed = matchesPermissions(tc, params.permissions);
  if (!isAllowed) {
    taggedEmit({
      type: "permission_required",
      runId,
      id: v7(),
      toolCallId: tc.id,
      tool: tc.name,
      params: tc.arguments,
    });
    continue;
  }

  // Execute tool...
}
```

### Agent Loop (agent.ts)

Stop looping when `permission_required` events occur:

```typescript
async invoke(params: InvokeParams): Promise<void> {
  let iterations = 0;
  let permissionRequired = false;

  while (iterations < maxIterations) {
    iterations++;
    permissionRequired = false;

    await innerHarness.invoke({
      ...params,
      emit: (event) => {
        if (event.type === "permission_required") {
          permissionRequired = true;
        }
        params.emit(event);
      },
    });

    if (permissionRequired) {
      return;
    }

    // ... existing logic
  }
}
```

### Glob Matching (permissions.ts)

```typescript
import { minimatch } from "minimatch";

export type ToolPermission = {
  tool: string;
  params?: Record<string, string>;
};

export type Permissions = {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
};

export function matchesPermission(
  toolCall: { name: string; arguments?: Record<string, unknown> },
  permission: ToolPermission
): boolean {
  if (toolCall.name !== permission.tool) {
    return false;
  }

  if (!permission.params) {
    return true;
  }

  for (const [paramName, pattern] of Object.entries(permission.params)) {
    const value = String(toolCall.arguments?.[paramName] ?? "");
    if (!minimatch(value, pattern)) {
      return false;
    }
  }

  return true;
}

export function matchesPermissions(
  toolCall: { name: string; arguments?: Record<string, unknown> },
  permissions?: Pick<Permissions, "allowlist" | "allowOnce">
): boolean {
  const allAllowed = [
    ...(permissions?.allowlist ?? []),
    ...(permissions?.allowOnce ?? []),
  ];
  return allAllowed.some((p) => matchesPermission(toolCall, p));
}
```

### API Route (server/index.ts)

```typescript
app.post("/chat", async (c) => {
  const { model, messages, tools, permissions } = await c.req.json();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: HarnessEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      await openRouterHarness.invoke({
        model,
        messages,
        tools,
        emit,
        permissions,
      });

      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
});
```

## Files to Modify

- `packages/ai/types.ts` - Add `ToolPermission`, `Permissions`, update `InvokeParams`, add `permission_required` event, move `runId` into `context`
- `packages/ai/harness/openrouter.ts` - Add permission checking before tool execution
- `packages/ai/harness/agent.ts` - Stop loop on `permission_required`
- `server/index.ts` - Pass through `permissions` object
- New: `packages/ai/permissions.ts` - Glob matching utility
