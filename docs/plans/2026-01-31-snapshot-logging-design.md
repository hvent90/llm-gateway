# Snapshot Logging Design

## Problem

The raw CSV log generates ~1000 lines / ~18K tokens for a single 6-agent swarm request. Most of that is noise (permission ceremonies, happy-path phase transitions). The primary debugging question is "where is it stuck NOW?" — the full timeline is unnecessary.

## Design

Replace the append-only CSV log with a **snapshot file** that is rewritten on every log call. The file contains:

1. An agent tree showing each agent's current phase and duration
2. Per-agent rolling buffers of the last 20 events

For a 6-agent swarm this is ~150 lines / ~2,500 tokens instead of ~1,000 lines / ~18,000 tokens.

### File format

```
=== agents ===
019c15a root    tool_exec_start  count=6         12.4s
a3b7f21 ├─sub1  perm_wait        tool=bash       8.2s  <<<
e9d2c44 ├─sub2  llm_call_start   model=glm-4.7   3.1s
f1a8b33 ├─sub3  done                              5.0s
c7e6d55 ├─sub4  stream_start                      1.2s
b2f4a11 ├─sub5  bash_start       cmd="ls -la"    0.8s
d8c3e22 └─sub6  done                              4.3s

=== 019c15a (root) last 20 ===
12:04:30.300,req_start,model=glm-4.7
12:04:30.311,loop_iter,iter=1 max=10
12:04:33.257,llm_call_end,dur=2946ms tools=6
12:04:34.594,tool_exec_start,count=6

=== a3b7f21 (sub1) last 20 ===
12:04:34.596,loop_iter,iter=1 max=10
12:04:35.675,llm_call_end,dur=1077ms tools=1
12:04:35.675,perm_check,tool=bash
12:04:35.675,perm_wait,tool=bash
```

- `<<<` marks the agent with the longest phase duration (probable hang)
- `done` replaces the phase when an agent finishes
- Per-agent sections keep events isolated — a stuck agent's history won't be pushed out by healthy agents
- Columns dropped vs raw CSV: `level` (always I), `run` in per-agent sections (redundant with section header)

### In-memory state

```typescript
interface AgentState {
  phase: string;
  detail: string;
  phaseStart: number;
  parentRunId: string | null; // null = root agent
  done: boolean;
  events: string[]; // circular buffer, max 20
}

// Map from short runId (7 chars) to state
const agents = new Map<string, AgentState>();
```

### Logger API changes

The `log()` function signature stays the same:

```typescript
function log(level: Level, run: string, phase: string, detail?: string): void
```

But internally it now:
1. Updates or creates the agent's state in the map
2. Pushes `${formatTime()},${phase},${detail}` to the agent's event buffer (circular, max 20)
3. Updates `phase`, `detail`, `phaseStart` on the agent
4. If phase is `no_tools` or `req_end`, marks agent as `done`
5. Rewrites `logs/gateway.log` with the full snapshot

### Agent tree ordering

Root agent first (the one with no `parentRunId`). Children after their parent. This is determined by the `subagent_spawn` log call which includes `parent=X`.

The `subagent_spawn` phase needs special handling: when the logger sees `phase=subagent_spawn`, it records the parent-child relationship from the detail field's `parent=` value.

The `agent_spawn` phase (no parent) marks the root.

### File rewriting

Use `Bun.write(path, content)` — synchronous, atomic on most filesystems. This is called on every `log()` invocation. For a swarm generating ~100 log calls/second, this is fine — each write is <10KB.

### Phases that mark completion

- `no_tools` — agent loop ended naturally
- `req_end` — request completed
- `max_iter` — hit max iterations (also done)

### The `-------` run for bash tool

Bash tool logs use `-------` as runId since they don't have an agent context. These are folded into their parent agent's event buffer by looking up which agent is currently in `tool_exec_start` phase. If no parent can be determined, they go into a `(tools)` section.

Actually — simpler: the bash tool log calls should be removed. The agent harness already logs `tool_exec_start` and `tool_exec_end` around tool execution. The bash-level detail (command, exit code, timeout) can be captured by enhancing `tool_exec_start` detail to include the tool name and args. This avoids the orphan run problem entirely.

### Configuration

Same as before: `LOG_LEVEL` env var controls minimum level. Default `I`.

## Files to modify

1. **Rewrite**: `packages/ai/logger.ts` — new snapshot-based implementation
2. **Rewrite**: `packages/ai/logger.test.ts` — tests for new behavior
3. **Edit**: `packages/ai/tools/bash.ts` — remove log calls (covered by agent harness)
4. **No changes**: all other files keep their existing `log()` calls unchanged
