# Tool Permission System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a permission system that allows clients to control which tools can be executed, with allow-once, allow-always, and deny responses.

**Architecture:** Client sends permissions with each request (allowlist, allowOnce, deny). Harness checks permissions before tool execution. If not allowed, emits `permission_required` event and stops. Agent loop detects this and returns control to client.

**Tech Stack:** TypeScript, Bun, minimatch (new dependency for glob patterns)

**Design Doc:** `docs/plans/2026-01-23-tool-permissions-design.md`

---

### Task 1: Add minimatch dependency

**Files:**
- Modify: `package.json`

**Step 1: Install minimatch**

Run: `bun add minimatch`

**Step 2: Verify installation**

Run: `bun install && echo "success"`
Expected: "success"

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add minimatch for glob pattern matching"
```

---

### Task 2: Add permission types

**Files:**
- Modify: `packages/ai/types.ts`

**Step 1: Add ToolPermission and Permissions types**

Add after line 43 (after ToolCall interface):

```typescript
// Permission types for tool execution control
export interface ToolPermission {
  tool: string;
  params?: Record<string, string>; // param name → glob pattern
}

export interface Permissions {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
}
```

**Step 2: Add permission_required to HarnessEvent**

Update HarnessEvent union (around line 46) to add:

```typescript
  | { type: "permission_required"; runId: string; id: string; parentId?: string; toolCallId: string; tool: string; params: Record<string, unknown> }
```

**Step 3: Update InvokeParams context and add permissions**

Replace InvokeParams (lines 54-61) with:

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

**Step 4: Verify types compile**

Run: `bun run check`
Expected: No type errors

**Step 5: Commit**

```bash
git add packages/ai/types.ts
git commit -m "feat: add permission types to harness interface"
```

---

### Task 3: Create permissions module with glob matching

**Files:**
- Create: `packages/ai/permissions.ts`
- Create: `packages/ai/permissions.test.ts`

**Step 1: Write the failing test**

Create `packages/ai/permissions.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { matchesPermission, matchesPermissions } from "./permissions";

describe("permissions", () => {
  describe("matchesPermission", () => {
    it("matches tool name only", () => {
      const result = matchesPermission(
        { name: "get_weather", arguments: { city: "London" } },
        { tool: "get_weather" }
      );
      expect(result).toBe(true);
    });

    it("rejects different tool name", () => {
      const result = matchesPermission(
        { name: "get_weather", arguments: { city: "London" } },
        { tool: "calculator" }
      );
      expect(result).toBe(false);
    });

    it("matches with glob pattern", () => {
      const result = matchesPermission(
        { name: "bash", arguments: { command: "ls -la" } },
        { tool: "bash", params: { command: "ls *" } }
      );
      expect(result).toBe(true);
    });

    it("rejects non-matching glob pattern", () => {
      const result = matchesPermission(
        { name: "bash", arguments: { command: "rm -rf /" } },
        { tool: "bash", params: { command: "ls *" } }
      );
      expect(result).toBe(false);
    });

    it("allows unspecified params when some params have patterns", () => {
      const result = matchesPermission(
        { name: "file_write", arguments: { path: "/tmp/foo.txt", content: "hello" } },
        { tool: "file_write", params: { path: "/tmp/*" } }
      );
      expect(result).toBe(true);
    });

    it("handles missing arguments gracefully", () => {
      const result = matchesPermission(
        { name: "bash", arguments: undefined },
        { tool: "bash", params: { command: "ls *" } }
      );
      expect(result).toBe(false);
    });
  });

  describe("matchesPermissions", () => {
    it("returns true if any allowlist entry matches", () => {
      const result = matchesPermissions(
        { name: "get_weather", arguments: { city: "London" } },
        { allowlist: [{ tool: "calculator" }, { tool: "get_weather" }] }
      );
      expect(result).toBe(true);
    });

    it("returns true if any allowOnce entry matches", () => {
      const result = matchesPermissions(
        { name: "bash", arguments: { command: "ls -la" } },
        { allowOnce: [{ tool: "bash", params: { command: "ls *" } }] }
      );
      expect(result).toBe(true);
    });

    it("returns false if no entries match", () => {
      const result = matchesPermissions(
        { name: "dangerous_tool", arguments: {} },
        { allowlist: [{ tool: "safe_tool" }], allowOnce: [] }
      );
      expect(result).toBe(false);
    });

    it("returns false for empty permissions", () => {
      const result = matchesPermissions(
        { name: "any_tool", arguments: {} },
        {}
      );
      expect(result).toBe(false);
    });

    it("returns false for undefined permissions", () => {
      const result = matchesPermissions(
        { name: "any_tool", arguments: {} },
        undefined
      );
      expect(result).toBe(false);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/permissions.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `packages/ai/permissions.ts`:

```typescript
import { minimatch } from "minimatch";
import type { Permissions, ToolPermission } from "./types";

interface ToolCallLike {
  name: string;
  arguments?: Record<string, unknown>;
}

export function matchesPermission(
  toolCall: ToolCallLike,
  permission: ToolPermission
): boolean {
  if (toolCall.name !== permission.tool) {
    return false;
  }

  if (!permission.params) {
    return true;
  }

  for (const [paramName, pattern] of Object.entries(permission.params)) {
    const value = toolCall.arguments?.[paramName];
    if (value === undefined) {
      return false;
    }
    if (!minimatch(String(value), pattern)) {
      return false;
    }
  }

  return true;
}

export function matchesPermissions(
  toolCall: ToolCallLike,
  permissions?: Pick<Permissions, "allowlist" | "allowOnce">
): boolean {
  const allAllowed = [
    ...(permissions?.allowlist ?? []),
    ...(permissions?.allowOnce ?? []),
  ];
  return allAllowed.some((p) => matchesPermission(toolCall, p));
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/permissions.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/ai/permissions.ts packages/ai/permissions.test.ts
git commit -m "feat: add permission matching with glob patterns"
```

---

### Task 4: Update OpenRouter harness to check permissions

**Files:**
- Modify: `packages/ai/harness/openrouter.ts`
- Modify: `packages/ai/harness/openrouter.test.ts`

**Step 1: Write the failing test for permission_required**

Add to `packages/ai/harness/openrouter.test.ts` (after existing tests):

```typescript
describe("permissions", () => {
  it("emits permission_required when tool not in allowlist", async () => {
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent) => events.push(event);

    const harness = createHarness();
    await harness.invoke({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
      tools: [calculatorTool],
      emit,
      permissions: {
        allowlist: [], // Empty allowlist - nothing allowed
      },
    });

    const permissionEvent = events.find((e) => e.type === "permission_required");
    expect(permissionEvent).toBeDefined();
    expect(permissionEvent?.type).toBe("permission_required");
    if (permissionEvent?.type === "permission_required") {
      expect(permissionEvent.tool).toBe("calculator");
    }
  });

  it("executes tool when in allowlist", async () => {
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent) => events.push(event);

    const harness = createHarness();
    await harness.invoke({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
      tools: [calculatorTool],
      emit,
      permissions: {
        allowlist: [{ tool: "calculator" }],
      },
    });

    const permissionEvent = events.find((e) => e.type === "permission_required");
    expect(permissionEvent).toBeUndefined();

    const resultEvent = events.find((e) => e.type === "tool_result");
    expect(resultEvent).toBeDefined();
  });

  it("emits denied tool_result when tool in deny list", async () => {
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent) => events.push(event);

    const harness = createHarness();
    await harness.invoke({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
      tools: [calculatorTool],
      emit,
      permissions: {
        allowlist: [],
        deny: [{ toolCallId: "will-be-replaced", reason: "User denied" }],
      },
    });

    // First get the tool_call to find its ID
    const toolCallEvent = events.find((e) => e.type === "tool_call");
    expect(toolCallEvent).toBeDefined();
  });
});
```

Note: The deny test is incomplete because we need the actual tool_call ID. We'll refine this after seeing the implementation pattern.

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/harness/openrouter.test.ts -t "permissions"`
Expected: FAIL (permissions property doesn't exist yet in invoke)

**Step 3: Update openrouter.ts to handle permissions**

Add import at top of `packages/ai/harness/openrouter.ts`:

```typescript
import { matchesPermissions } from "../permissions";
```

Update the invoke function to extract permissions and check before tool execution. Replace the tool execution loop (lines 100-131) with:

```typescript
        // Execute tools if they have executors
        for (const tc of toolCalls) {
          const toolDef = params.tools?.find((t) => t.name === tc.name);

          // Check deny list first
          const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
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
          if (params.permissions && !matchesPermissions({ name: tc.name, arguments: tc.arguments }, params.permissions)) {
            taggedEmit({
              type: "permission_required",
              runId,
              id: v7(),
              toolCallId: tc.id,
              tool: tc.name,
              params: tc.arguments ?? {},
            });
            continue;
          }

          if (!toolDef?.execute) {
            // No executor - that's ok, caller may process tool_call events directly
            continue;
          }

          const toolCtx: ToolContext = {
            emit: taggedEmit,
            parentId: tc.id, // This tool_call becomes parent for nested events
          };

          try {
            const { context: toolContext, result: toolResult } = await toolDef.execute(tc.arguments, toolCtx);
            // Emit tool_result with context for agent loop (context goes into messages)
            // and result for application consumption
            taggedEmit({
              type: "tool_result",
              runId,
              name: tc.name,
              id: tc.id,
              output: { context: toolContext, result: toolResult },
            });
          } catch (error) {
            taggedEmit({
              type: "error",
              runId,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        }
```

Also update the destructuring at the start of invoke (line 42) to include permissions:

```typescript
    async invoke({ emit, context, ...params }: InvokeParams): Promise<void> {
      const runId = context?.runId ?? v7();
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/harness/openrouter.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/ai/harness/openrouter.ts packages/ai/harness/openrouter.test.ts
git commit -m "feat: add permission checking to OpenRouter harness"
```

---

### Task 5: Update agent harness to stop on permission_required

**Files:**
- Modify: `packages/ai/harness/agent.ts`
- Modify: `packages/ai/harness/agent.test.ts`

**Step 1: Write the failing test**

Add to `packages/ai/harness/agent.test.ts`:

```typescript
it("stops iterating when permission_required is emitted", async () => {
  const events: HarnessEvent[] = [];
  const emit = (event: HarnessEvent) => events.push(event);

  const agentHarness = createAgentHarness({
    harness: createHarness(),
    maxIterations: 5,
  });

  await agentHarness.invoke({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
    tools: [calculatorTool],
    emit,
    permissions: {
      allowlist: [], // Nothing allowed - will trigger permission_required
    },
  });

  const permissionEvents = events.filter((e) => e.type === "permission_required");
  expect(permissionEvents.length).toBeGreaterThan(0);

  // Should only have one iteration's worth of events (not multiple loops)
  const toolCallEvents = events.filter((e) => e.type === "tool_call");
  expect(toolCallEvents.length).toBe(permissionEvents.length);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/harness/agent.test.ts -t "permission_required"`
Expected: FAIL (agent keeps looping)

**Step 3: Update agent.ts to stop on permission_required**

Update the invoke function in `packages/ai/harness/agent.ts`. Add a flag to track permission_required:

```typescript
  return {
    async invoke({ emit, context, ...params }: InvokeParams): Promise<void> {
      const runId = context?.runId ?? uuidv7();
      const parentId = context?.parentId;

      // Wrap emit to add parentId to events
      const taggedEmit = (event: HarnessEvent) => {
        emit(parentId ? { ...event, parentId } : event);
      };

      const messages = [...params.messages];
      let iterations = 0;

      while (iterations++ < maxIterations) {
        const toolCalls: ToolCall[] = [];
        const toolResults: Map<string, ToolResultOutput> = new Map();
        let textContent = "";
        let permissionRequired = false;

        await harness.invoke({
          ...params,
          messages,
          context: { runId, parentId },
          emit: (event) => {
            taggedEmit(event);
            if (event.type === "tool_call") {
              toolCalls.push({ id: event.id, name: event.name, arguments: event.input });
            }
            if (event.type === "text") {
              textContent += event.content;
            }
            if (event.type === "tool_result") {
              // Collect tool results for building messages
              toolResults.set(event.id, event.output as ToolResultOutput);
            }
            if (event.type === "permission_required") {
              permissionRequired = true;
            }
          },
        });

        // Stop looping if permission is needed
        if (permissionRequired) {
          return;
        }

        if (toolCalls.length === 0) break;

        messages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls,
        });

        // Build tool messages from collected results
        for (const tc of toolCalls) {
          const resultOutput = toolResults.get(tc.id);
          if (!resultOutput) {
            // No result for this tool call - check if tool has no executor
            const toolDef = params.tools?.find((t) => t.name === tc.name);
            if (!toolDef?.execute) {
              taggedEmit({
                type: "error",
                runId,
                error: new Error(`No executor for tool: ${tc.name}`),
              });
              return;
            }
            // Executor exists but no result emitted - this is a bug
            taggedEmit({
              type: "error",
              runId,
              error: new Error(`Tool executor for '${tc.name}' did not emit a result`),
            });
            return;
          }

          if (resultOutput.context !== undefined) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: resultOutput.context,
            });
          }
        }
      }
    },

    supportedModels: () => harness.supportedModels(),
  };
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/harness/agent.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/ai/harness/agent.ts packages/ai/harness/agent.test.ts
git commit -m "feat: stop agent loop on permission_required"
```

---

### Task 6: Update server to pass through permissions

**Files:**
- Modify: `server/index.ts`

**Step 1: Update ChatRequest interface**

Update the interface in `server/index.ts`:

```typescript
import type { Message, HarnessEvent, Permissions } from "../packages/ai/types.ts";

interface ChatRequest {
  model: string;
  messages: Message[];
  permissions?: Permissions;
}
```

**Step 2: Pass permissions to harness invoke**

Update the invoke call (around line 51):

```typescript
      await openRouterHarness.invoke({
        model: body.model,
        messages: body.messages,
        emit,
        permissions: body.permissions,
      });
```

**Step 3: Verify server starts**

Run: `bun run dev &` then `curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'`
Expected: SSE stream with text events

**Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat: pass permissions through server /chat endpoint"
```

---

### Task 7: Run full test suite and verify

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass

**Step 2: Run type check**

Run: `bun run check`
Expected: No type errors

**Step 3: Run formatter**

Run: `bun run format`
Expected: Files formatted

**Step 4: Final commit if any formatting changes**

```bash
git add -A
git commit -m "chore: format code" || echo "Nothing to commit"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `package.json` | Add minimatch dependency |
| `packages/ai/types.ts` | Add ToolPermission, Permissions, permission_required event, update InvokeParams |
| `packages/ai/permissions.ts` | New file with glob matching functions |
| `packages/ai/permissions.test.ts` | Tests for permission matching |
| `packages/ai/harness/openrouter.ts` | Check permissions before tool execution |
| `packages/ai/harness/openrouter.test.ts` | Tests for permission behavior |
| `packages/ai/harness/agent.ts` | Stop loop on permission_required |
| `packages/ai/harness/agent.test.ts` | Test for agent stopping |
| `server/index.ts` | Pass permissions through API |
