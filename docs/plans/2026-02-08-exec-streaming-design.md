# Exec Streaming & Process Monitoring

Stream stdout/stderr and process metrics from `exec()` calls in real-time to the consumer via a new `tool_progress` event.

## Goal

End-user observability. The web client sees live output and health metrics while `exec()` runs inside an RLM REPL execution. The model does not see these events — they are consumer-only.

## Scope

- Applies to **all** exec() calls (no threshold gating)
- Metrics polled at **fixed 1s** interval (not configurable)
- Frontend rendering is out of scope for this design

## New Event Type: `tool_progress`

Added to the `HarnessEvent` union in `types.ts`:

```ts
| {
    type: "tool_progress";
    runId: string;
    id: string;
    parentId?: string;
    toolCallId: string;   // links to the parent tool_call
    name: string;         // tool name (e.g., "exec")
    content: unknown;     // tool-specific payload, client interprets per tool name
  }
```

This is a general-purpose event — not exec-specific. Any tool can emit progress events. The client decides how to render based on `name` + the shape of `content`.

### Event Lifecycle

```
tool_call { name: "repl_execute", id: "abc" }
  tool_progress { toolCallId: "abc", name: "exec", content: { channel: "stdout", data: "..." } }
  tool_progress { toolCallId: "abc", name: "exec", content: { pid, cpuPercent, rssKb, wallMs } }
  tool_progress { toolCallId: "abc", name: "exec", content: { channel: "stderr", data: "..." } }
  tool_progress { toolCallId: "abc", name: "exec", content: { pid, cpuPercent, rssKb, wallMs } }
tool_result { name: "repl_execute", id: "abc" }
```

## Architecture

### How Events Flow

The existing `AsyncQueue` + drain loop pattern (used for HITL relay events) is reused. The `ExecQueueItem` union expands:

```ts
// Current
type ExecQueueItem =
  | { type: "relay"; event: RelayEvent }
  | { type: "repl_done"; result: ReplExecutionResult }

// New
type ExecQueueItem =
  | { type: "relay"; event: RelayEvent }
  | { type: "progress"; event: HarnessEvent }
  | { type: "repl_done"; result: ReplExecutionResult }
```

The drain loop already works for this — it yields `item.event` for anything that isn't `repl_done`. No drain loop changes needed.

### Monitored Exec Implementation

The exec callback inside `createRlmHarness()` replaces `execShell()` with inline `Bun.spawn` to get access to live streams and the PID:

```
exec(command, timeout?)
  -> permission check (unchanged)
  -> Bun.spawn(["sh", "-c", command])
  -> start 3 concurrent tasks:
      1. drain proc.stdout -> push tool_progress { channel: "stdout", data } onto queue
      2. drain proc.stderr -> push tool_progress { channel: "stderr", data } onto queue
      3. poll metrics every 1s -> push tool_progress { pid, cpuPercent, rssKb, wallMs } onto queue
  -> await proc.exited
  -> stop metrics poller
  -> return { stdout, stderr, exitCode } (same ShellResult shape as today)
```

Key details:

- **stdout/stderr are still collected** into strings and returned in the ShellResult. Streaming is a side-channel; the REPL return value doesn't change.
- **Metrics polling** spawns `ps -p <pid> -o %cpu,rss` every 1s as a separate child process.
- **Timeout handling** unchanged — kill process group after `config.execTimeout`.
- **Multiple exec() calls** within a single `repl.execute()` all push onto the same queue. The drain loop yields them interleaved.

## File Changes

| File | Change |
|---|---|
| `packages/ai/types.ts` | Add `tool_progress` to `HarnessEvent` union |
| `packages/ai/rlm/harness.ts` | Replace `execShell()` with `Bun.spawn` + stream draining + metrics polling; push `tool_progress` events onto `execEvents` queue |
| `packages/ai/rlm/types.ts` | Add `{ type: "progress"; event: HarnessEvent }` to `ExecQueueItem` |

### No Changes Required

| File | Why |
|---|---|
| `packages/ai/tools/lib/shell.ts` | `execShell` stays for other consumers; RLM harness just stops using it |
| `packages/ai/orchestrator.ts` | `tool_progress` passes through like `text` or `usage` — not a relay |
| `server/index.ts` | SSE streaming already serializes any `HarnessEvent` |
| `packages/ai/multiplexer.ts` | No special handling needed |

## Testing

- Harness test: verify exec() produces `tool_progress` events with stdout/stderr chunks and metrics between `tool_call` and `tool_result`
- Metrics parser test: verify `ps` output parsing handles edge cases
