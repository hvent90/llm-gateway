# Batch Approve Same-Type Tool Calls

When an agent returns multiple tool calls, each requires individual user approval. Clicking "Allow All" on one should also resolve all other pending tool calls of the same type, since the user just granted that tool permanently.

## Problem

The agent emits multiple tool calls (e.g., 3 `read_file` calls). Each arrives as a `relay` event and gets its own `PermissionPrompt`. When the user clicks "Allow All" on one, only that single relay is resolved. The other same-type relays remain pending despite the tool now being in `grantedTools`.

## Design

### 1. Modify `handleAllowAll` to batch-resolve same-type relays

In `clients/web/src/App.tsx`, change `handleAllowAll` to:

1. Collect all pending relays where `relay.tool === clickedRelay.tool`
2. Dispatch `relay_resolved` for each (with `approved: true` for the first to grant the tool, and `approved: false` for the rest since the tool is already granted)
3. Fire `resolveRelay` HTTP calls for all of them in parallel

```typescript
const handleAllowAll = useCallback(
  async (relay: PendingRelay) => {
    if (!state.sessionId) return;

    // Find all pending relays of the same tool type
    const sameTypeRelays = state.pendingRelays.filter(
      (r) => r.tool === relay.tool,
    );

    // Resolve all in state — grant tool on the first one
    setState((s) => {
      let current = s;
      for (const r of sameTypeRelays) {
        current = reduceConversation(current, {
          type: "relay_resolved",
          relayId: r.relayId,
          tool: r.tool,
          approved: r.relayId === relay.relayId, // grant on the clicked one
        });
      }
      return current;
    });

    // Approve all on the server in parallel
    await Promise.all(
      sameTypeRelays.map((r) =>
        httpTransport.resolveRelay(state.sessionId!, r.relayId, {
          approved: true,
        }),
      ),
    );
  },
  [state.sessionId, state.pendingRelays],
);
```

### 2. Auto-resolve incoming relays for granted tools

Relay events arrive via SSE and may arrive after the user has already granted the tool. Add a `useEffect` that auto-resolves new pending relays if their tool is already in `grantedTools`.

```typescript
useEffect(() => {
  if (!state.sessionId) return;

  const autoApprovable = state.pendingRelays.filter((r) =>
    state.grantedTools.has(r.tool),
  );

  if (autoApprovable.length === 0) return;

  // Resolve in state
  setState((s) => {
    let current = s;
    for (const r of autoApprovable) {
      current = reduceConversation(current, {
        type: "relay_resolved",
        relayId: r.relayId,
        tool: r.tool,
        approved: false, // tool already granted
      });
    }
    return current;
  });

  // Approve on server
  for (const r of autoApprovable) {
    httpTransport.resolveRelay(state.sessionId, r.relayId, {
      approved: true,
    });
  }
}, [state.pendingRelays, state.grantedTools, state.sessionId]);
```

## Files Changed

| File | Change |
|------|--------|
| `clients/web/src/App.tsx` | Modify `handleAllowAll` to loop through same-type pending relays. Add `useEffect` to auto-resolve incoming relays for granted tools. |

## Testing

- Verify that clicking "Allow All" on one `read_file` relay resolves all pending `read_file` relays
- Verify that a `bash` relay remains pending when `read_file` is batch-approved
- Verify that a relay arriving after its tool is granted gets auto-resolved without showing a prompt
