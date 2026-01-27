# Relay Event Design

Replace `permission_required` with a generalized `relay` event type.

## Motivation

The harness currently has a `permission_required` event for human-in-the-loop tool approval. This is one instance of a general pattern: the agent passes control to a human, waits, then continues. Generalizing to a `relay` event with discriminated `kind` makes future relay kinds (input, confirm, branch) trivial to add.

The codebase is young with no external consumers, so this is a clean break — no deprecation period.

## Type System

### Response types (one per relay kind)

```typescript
type PermissionResponse = { approved: boolean; reason?: string };
```

### Relay event (discriminated union on `kind`)

```typescript
type RelayEvent =
  | {
      type: "relay";
      kind: "permission";
      runId: string;
      id: string;
      parentId?: string;
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
      respond: (response: PermissionResponse) => void;
    };
```

`HarnessEvent` replaces its `permission_required` branch with `RelayEvent`. Future kinds add new branches — no existing code changes.

## Orchestrator

The orchestrator generalizes its permission plumbing:

- `PendingPermission` → `PendingRelay` — stores `agentId`, relay `kind`, and `respond` callback (typed as `(response: unknown) => void` internally).
- `resolvePermission()` → `resolveRelay()` — takes relay event `id` (not `toolCallId`) and a response value.
- `pendingPermissions` keyed by `toolCallId` → `pendingRelays` keyed by relay event `id`.
- `ConsumerHarnessEvent` strips `respond` from relay events.
- `events()` generator checks `event.type === "relay"` instead of `"permission_required"`.

The orchestrator stays relay-kind-agnostic. It pauses, stashes, strips, and resumes without switching on `kind`.

## Agent Harness

The agent harness (`harness/agent.ts`) yields `{ type: "relay", kind: "permission" }` instead of `{ type: "permission_required" }`. The deferred promise resolves with `PermissionResponse`. Control flow is unchanged.

## Changes

| File | Change |
|------|--------|
| `packages/ai/types.ts` | Remove `permission_required` from `HarnessEvent`, add `RelayEvent` union, export `PermissionResponse` |
| `packages/ai/orchestrator.ts` | `PendingPermission` → `PendingRelay`, `resolvePermission()` → `resolveRelay()`, key by relay `id`, update `ConsumerHarnessEvent` |
| `packages/ai/harness/agent.ts` | Yield relay event, use `PermissionResponse` |
| `packages/ai/__tests__/orchestrator.test.ts` | Update event assertions and resolve calls |
| `packages/ai/__tests__/types.test.ts` | Update type assertions |
| `packages/ai/harness/__tests__/agent.test.ts` | Update event assertions |

**Unchanged:** `permissions.ts`, `multiplexer.ts`, provider harnesses, client package.
