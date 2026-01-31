# Mutable Permissions via Orchestrator

## Overview

Move permission persistence from the client to the server. The `Permissions` object becomes a shared mutable reference owned by the orchestrator. When a relay is resolved with "always allow," the orchestrator mutates the shared allowlist so future tool calls are auto-approved without relay round-trips.

## Key Decisions

| Aspect | Decision |
|--------|----------|
| Permissions ownership | Orchestrator holds a mutable reference; agent harness reads it each iteration |
| Grant API | Part of `resolveRelay` — `{ approved: true, always: true }` |
| Grant scope | Param-scoped via "first word + `**`" derivation |
| Subagent propagation | Shared ref — subagents see mutations immediately |
| Client-side `grantedTools` | Removed — server handles persistence |

## Current State

The agent harness checks `params.permissions` on every loop iteration but never mutates it. The orchestrator's `resolveRelay` calls `respond()` but doesn't touch permissions. The client maintains a separate `grantedTools: Set<string>` to auto-approve relays for previously approved tools — this is a client-side workaround for the lack of server-side persistence.

## Design

### Shared mutable reference

The `Permissions` object is passed by reference through the agent tree:

```
orchestrator.spawn(params)
  └── permissions object (shared ref)
       ├── agent harness reads it each iteration
       └── subagents receive same ref via spawnSubagent
```

The agent harness re-reads `params.permissions` on every loop iteration (`matchesPermissions` at the start of each tool call check). Mutations between iterations are picked up automatically. No changes needed to the agent harness or permissions module.

### resolveRelay API

```ts
type ResolveResponse =
  | { approved: true; always?: boolean }
  | { approved: false; reason?: string };
```

- `approved: true` — approve this tool call (once)
- `approved: true, always: true` — approve and add to allowlist
- `approved: false` — deny with optional reason

The `PermissionResponse` type that the agent harness receives via `respond()` is unchanged: `{ approved: boolean; reason?: string }`.

### Pattern derivation

When `always: true`, derive a `ToolPermission` from the relay event's `tool` and `params`:

For each string param value:
1. Split by first space
2. If two parts: pattern = `firstWord + " **"` (matches any arguments)
3. If single word (no space): pattern = exact value

Examples:
```
relay: { tool: "bash", params: { command: "cat /tmp/foo.txt" } }
  → permission: { tool: "bash", params: { command: "cat **" } }

relay: { tool: "bash", params: { command: "ls -la" } }
  → permission: { tool: "bash", params: { command: "ls **" } }

relay: { tool: "get_weather", params: { city: "London" } }
  → permission: { tool: "get_weather", params: { city: "London" } }
```

Uses `**` instead of `*` because minimatch's `*` does not match `/` by default, and tool params often contain paths.

### PendingRelay update

```ts
interface PendingRelay {
  agentId: string;
  tool: string;
  params: Record<string, unknown>;
  permissions: Permissions;   // ref to shared mutable object
  respond: (response: any) => void;
}
```

The orchestrator stashes the relay's `tool`, `params`, and the `permissions` reference alongside the `respond` callback. This gives `resolveRelay` everything it needs to derive and push the permission.

### Orchestrator method changes

**`events()`** — stash `tool`, `params`, and `permissions` ref when intercepting relay events:
```ts
this.pendingRelays.set(event.id, {
  agentId,
  tool: event.tool,
  params: event.params,
  permissions: ???,  // need to track per-agent
  respond: event.respond,
});
```

The orchestrator needs to track which `Permissions` object belongs to each agent. Since `spawn()` and `spawnSubagent()` both have access to the params, we store a mapping from `agentId → Permissions`.

**`resolveRelay()`** — when `always: true`, derive permission and mutate:
```ts
resolveRelay(relayId: string, response: ResolveResponse): boolean {
  const pending = this.pendingRelays.get(relayId);
  if (!pending) return false;

  if (response.approved) {
    if (response.always) {
      const permission = derivePermission(pending.tool, pending.params);
      pending.permissions.allowlist ??= [];
      pending.permissions.allowlist.push(permission);
    }
    pending.respond({ approved: true });
  } else {
    pending.respond({ approved: false, reason: response.reason });
  }

  this.mux.resume(pending.agentId);
  this.pendingRelays.delete(relayId);
  return true;
}
```

**`spawn()` and `spawnSubagent()`** — no logic changes, but need to track the permissions ref per agent.

### derivePermission function

```ts
function derivePermission(
  tool: string,
  params: Record<string, unknown>,
): ToolPermission {
  const globParams: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    const str = String(value);
    const spaceIdx = str.indexOf(" ");
    if (spaceIdx > 0) {
      globParams[key] = str.slice(0, spaceIdx) + " **";
    } else {
      globParams[key] = str;
    }
  }

  return Object.keys(globParams).length > 0
    ? { tool, params: globParams }
    : { tool };
}
```

## Client-side impact

The following become dead code in `packages/ai/client/conversation.ts` and can be removed:
- `grantedTools: Set<string>` from `ConversationState`
- `getAutoApprovableRelays()` function
- `getSameToolRelays()` function
- The `grantedTools` mutation in the `relay_resolved` reducer case

The client still dispatches `relay_resolved` events but no longer needs to track granted tools — the server handles it.

## Files changed

| File | Change |
|------|--------|
| `packages/ai/orchestrator.ts` | `PendingRelay` type, `resolveRelay` signature, pattern derivation, allowlist mutation, per-agent permissions tracking |
| `packages/ai/client/conversation.ts` | Remove `grantedTools`, `getAutoApprovableRelays`, `getSameToolRelays` |

No changes to `packages/ai/harness/agent.ts`, `packages/ai/permissions.ts`, or `packages/ai/types.ts`.
