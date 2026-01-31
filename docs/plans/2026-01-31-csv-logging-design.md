# CSV Logging for Claude Code Debugging

## Problem

The agent while-loop hangs intermittently with no visibility into where it stalls. There are multiple async `await` points that can block silently: LLM API calls, permission relay waits, tool execution, and subagent spawns. Without logs, debugging requires guesswork.

## Design

### Log format: CSV optimized for LLM context windows

Fixed 5-column CSV. Header written once at file start. One line per phase transition.

```
time,level,run,phase,detail
12:00:00.123,I,a1b2c3d,llm_call_start,model=claude-sonnet-4-20250514 iter=1
12:00:02.456,I,a1b2c3d,llm_call_end,dur=2333ms tok_in=1200 tok_out=85
```

- **time**: `HH:MM:SS.mmm` (no date — file resets per session)
- **level**: `D` debug, `I` info, `W` warn, `E` error (single char saves tokens)
- **run**: first 7 chars of the agent's runId (enough to distinguish agents)
- **phase**: the operation name (see phase catalog below)
- **detail**: key=value pairs, CSV-quoted if it contains commas

### Logger module

`packages/ai/logger.ts` — single module, explicit API:

```typescript
type Level = "D" | "I" | "W" | "E";
function log(level: Level, run: string, phase: string, detail?: string): void
```

Behavior:
- File: `logs/gateway.log` relative to project root
- Truncates file on first write (reset per server session)
- Writes CSV header on first write
- Filters by `LOG_LEVEL` env var (default: `I` — shows I/W/E, hides D)
- Uses `Bun.file().writer()` for fast appends
- `run` auto-truncated to 7 chars

### Phase catalog

Every log point, traced to source code location.

#### Server layer (`server/index.ts`)

| Phase | Location | Detail |
|---|---|---|
| `req_start` | POST /chat entry | `session=X model=X` |
| `req_end` | finally block | `session=X dur=Xms` |

#### Orchestrator layer (`packages/ai/orchestrator.ts`)

| Phase | Location | Detail |
|---|---|---|
| `agent_spawn` | `spawn()` | `agent=X model=X parent=none` |
| `subagent_spawn` | `spawnSubagent()` | `agent=X parent=X/Y` |
| `subagent_done` | return from `spawnSubagent()` | `agent=X dur=Xms` |
| `relay_stash` | relay handling in `events()` | `relay=X agent=X tool=X` |
| `relay_resolve` | `resolveRelay()` | `relay=X agent=X` |

#### Agent harness layer (`packages/ai/harness/agent.ts`)

| Phase | Location | Detail |
|---|---|---|
| `loop_iter` | while loop top (line 52) | `iter=N max=N` |
| `llm_call_start` | before `for await` on provider (line 57) | `model=X` |
| `llm_call_end` | after `for await` completes (line 84) | `dur=Xms tools=N` |
| `perm_check` | `!isAllowed` branch (line 131) | `tool=X` |
| `perm_wait` | before `await promise` (line 146) | `tool=X toolCallId=X` |
| `perm_resolved` | after `await promise` (line 146) | `tool=X approved=X waited=Xms` |
| `tool_exec_start` | before `Promise.all` (line 195) | `count=N` |
| `tool_exec_end` | after `Promise.all` (line 239) | `dur=Xms` |
| `no_tools` | empty toolCalls (line 87) | (none) |
| `max_iter` | while condition fails (line 52) | `iter=N` |

#### Provider layer (`packages/ai/harness/providers/zen.ts`)

| Phase | Location | Detail |
|---|---|---|
| `api_req` | `fetch()` call (line 147) | `url=X` |
| `api_res` | response received (line 163) | `status=N` |
| `stream_start` | entering SSE parse loop (line 184) | (none) |
| `stream_end` | after SSE loop (line 246) | `dur=Xms` |
| `api_err` | catch on fetch (line 155) | `msg="..."` |

#### Tool layer (`packages/ai/tools/bash.ts`)

| Phase | Location | Detail |
|---|---|---|
| `bash_start` | `spawn()` call (line 35) | `cmd="X"` |
| `bash_end` | after race (line 91) | `dur=Xms exit=N` |
| `bash_timeout` | timedOut (line 84) | `timeout=Ns cmd="X"` |

#### DEBUG-level event logging (all layers)

At DEBUG level, every `HarnessEvent` yielded through the system also gets a log line:

| Event type | Logged detail |
|---|---|
| `reasoning` | `type=reasoning id=X len=N` |
| `text` | `type=text id=X len=N` |
| `tool_call` | `type=tool_call name=X id=X input="<truncated 200>"` |
| `tool_result` | `type=tool_result name=X id=X output_len=N` |
| `usage` | `type=usage tok_in=N tok_out=N` |
| `error` | `type=error msg="..."` |
| `relay` | `type=relay kind=X tool=X` |

Content bodies (reasoning text, tool output) are NOT logged — only lengths. Tool call `input` is truncated to 200 chars.

### Parent-child tracing

Subagent lineage is captured through the `parent` field in `agent_spawn` / `subagent_spawn`:

```
12:00:00.002,I,a1b2c3d,agent_spawn,parent=none
12:00:04.102,I,e5f6g7h,subagent_spawn,parent=a1b2c3d/tc001
```

This lets you reconstruct the agent tree: `e5f6g7h` was spawned by `a1b2c3d` via tool call `tc001`.

### Configuration

| Env var | Default | Values |
|---|---|---|
| `LOG_LEVEL` | `I` | `D`, `I`, `W`, `E` |

### File lifecycle

- Log file truncated on first write after server start
- File path: `logs/gateway.log`
- `logs/` directory created automatically if missing
- Add `logs/` to `.gitignore`

### Example: diagnosing a hang

If the agent loop stalls, the log would show:

```
12:00:01.502,I,a1b2c3d,perm_wait,tool=bash
```

...followed by silence. The last line pinpoints the exact phase and timestamp. The gap between the last log line and "now" reveals how long it's been stuck.

## Files to modify

1. **New**: `packages/ai/logger.ts` — logger module
2. **Edit**: `server/index.ts` — req_start, req_end logs; truncate log file on startup
3. **Edit**: `packages/ai/orchestrator.ts` — agent_spawn, subagent_spawn/done, relay_stash/resolve logs
4. **Edit**: `packages/ai/harness/agent.ts` — loop_iter, llm_call, perm, tool_exec logs
5. **Edit**: `packages/ai/harness/providers/zen.ts` — api_req/res, stream_start/end logs
6. **Edit**: `packages/ai/tools/bash.ts` — bash_start/end/timeout logs
7. **Edit**: `.gitignore` — add `logs/`
8. **Edit**: `.env.example` — add `LOG_LEVEL`
