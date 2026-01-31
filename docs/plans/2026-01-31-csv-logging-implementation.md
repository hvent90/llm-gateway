# CSV Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add CSV logging across the server, orchestrator, agent harness, provider, and tools so Claude Code can read `logs/gateway.log` to diagnose agent loop hangs.

**Architecture:** A single `packages/ai/logger.ts` module exports a `log()` function. Each layer imports it and calls it at async boundary points. The log file is truncated on first write per server session. One commit for the entire implementation.

**Tech Stack:** Bun (`Bun.file`, `mkdirSync`), no external dependencies.

---

### Task 1: Create the logger module

**Files:**
- Create: `packages/ai/logger.ts`
- Create: `packages/ai/logger.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { log, resetForTesting } from "./logger";

const LOG_DIR = "logs";
const LOG_FILE = "logs/gateway.log";

beforeEach(() => {
  if (existsSync(LOG_FILE)) rmSync(LOG_FILE);
  resetForTesting();
});

describe("logger", () => {
  test("creates log file with CSV header on first write", () => {
    log("I", "abc1234-rest-of-uuid", "test_phase", "key=value");
    const content = Bun.file(LOG_FILE).textSync();
    const lines = content.trimEnd().split("\n");
    expect(lines[0]).toBe("time,level,run,phase,detail");
    expect(lines.length).toBe(2);
  });

  test("truncates runId to 7 chars", () => {
    log("I", "0195e5a0-1234-7000-8000-000000000000", "test_phase");
    const content = Bun.file(LOG_FILE).textSync();
    const dataLine = content.trimEnd().split("\n")[1];
    const run = dataLine.split(",")[2];
    expect(run).toBe("0195e5a");
  });

  test("formats time as HH:MM:SS.mmm", () => {
    log("I", "abc1234", "test_phase");
    const content = Bun.file(LOG_FILE).textSync();
    const dataLine = content.trimEnd().split("\n")[1];
    const time = dataLine.split(",")[0];
    expect(time).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  test("filters DEBUG when LOG_LEVEL is I", () => {
    // Default LOG_LEVEL is I
    log("D", "abc1234", "debug_phase");
    const content = Bun.file(LOG_FILE).textSync();
    // Only header, no data line
    expect(content.trimEnd().split("\n").length).toBe(1);
  });

  test("CSV-quotes detail containing commas", () => {
    log("I", "abc1234", "test_phase", 'key=value1,value2 other="stuff"');
    const content = Bun.file(LOG_FILE).textSync();
    const dataLine = content.trimEnd().split("\n")[1];
    // The detail field should be quoted
    expect(dataLine).toContain('"key=value1,value2 other=""stuff"""');
  });

  test("handles empty detail", () => {
    log("I", "abc1234", "no_tools");
    const content = Bun.file(LOG_FILE).textSync();
    const dataLine = content.trimEnd().split("\n")[1];
    expect(dataLine).toMatch(/,no_tools,$/);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/logger.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the logger**

```typescript
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

export type Level = "D" | "I" | "W" | "E";

const LEVEL_ORDER: Record<Level, number> = { D: 0, I: 1, W: 2, E: 3 };
const LOG_DIR = join(import.meta.dir, "../../logs");
const LOG_FILE = join(LOG_DIR, "gateway.log");

let writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
let initialized = false;

function getMinLevel(): Level {
  const env = process.env.LOG_LEVEL;
  if (env === "D" || env === "I" || env === "W" || env === "E") return env;
  return "I";
}

function ensureWriter(): ReturnType<ReturnType<typeof Bun.file>["writer"]> {
  if (!writer) {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    // Truncate on first open per process
    Bun.write(LOG_FILE, "");
    writer = Bun.file(LOG_FILE).writer();
    initialized = false;
  }
  return writer;
}

function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function log(level: Level, run: string, phase: string, detail?: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinLevel()]) {
    // Still ensure file is initialized so header is written even if first call is filtered
    if (!initialized) {
      const w = ensureWriter();
      w.write("time,level,run,phase,detail\n");
      w.flush();
      initialized = true;
    }
    return;
  }

  const w = ensureWriter();
  if (!initialized) {
    w.write("time,level,run,phase,detail\n");
    initialized = true;
  }

  const shortRun = run.replace(/-/g, "").slice(0, 7);
  const detailStr = detail ? csvEscape(detail) : "";
  w.write(`${formatTime()},${level},${shortRun},${phase},${detailStr}\n`);
  w.flush();
}

export function resetForTesting(): void {
  if (writer) {
    writer.flush();
    writer.end();
  }
  writer = null;
  initialized = false;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/logger.test.ts`
Expected: PASS

---

### Task 2: Add logging to the Zen provider

**Files:**
- Modify: `packages/ai/harness/providers/zen.ts`

**Step 1: Add log calls**

Add `import { log } from "../../logger";` at top.

Add these log calls inside the `invoke` generator:

1. Before `fetch()` (line 147): `log("I", runId, "api_req", \`model=${params.model}\`);`
2. After response received (line 163): `log("I", runId, "api_res", \`status=${response.status}\`);`
3. On fetch error catch (line 155): `log("E", runId, "api_err", \`msg=${error instanceof Error ? error.message : String(error)}\`);`
4. Before SSE parse loop (line 184): add `const streamStart = Date.now();` then `log("I", runId, "stream_start");`
5. After SSE parse loop (line 238): `log("I", runId, "stream_end", \`dur=${Date.now() - streamStart}ms\`);`
6. On stream error catch (line 239): `log("E", runId, "api_err", \`msg=${error instanceof Error ? error.message : String(error)}\`);`

**Step 2: Verify existing tests still pass**

Run: `bun test packages/ai/harness/providers/__tests__/zen.test.ts`
Expected: PASS (log calls are side-effect-only, don't affect behavior)

---

### Task 3: Add logging to the agent harness

**Files:**
- Modify: `packages/ai/harness/agent.ts`

**Step 1: Add log calls**

Add `import { log } from "../logger";` at top.

Add these log calls inside the `invoke` generator:

1. At while loop top (after line 53): `log("I", myRunId, "loop_iter", \`iter=${iterations} max=${maxIterations}\`);`
2. Before `for await` on provider (before line 71): add `const llmStart = Date.now();` then `log("I", myRunId, "llm_call_start", \`model=${params.model}\`);`
3. After `for await` completes (after line 99): `log("I", myRunId, "llm_call_end", \`dur=${Date.now() - llmStart}ms tools=${toolCalls.length}\`);`
4. When no tool calls (at line 102): `log("I", myRunId, "no_tools");`
5. At `!isAllowed` permission branch (line 146): `log("I", myRunId, "perm_check", \`tool=${tc.name}\`);`
6. Before `await promise` (before line 161): add `const permStart = Date.now();` then `log("I", myRunId, "perm_wait", \`tool=${tc.name} toolCallId=${nsId(tc.id)}\`);`
7. After `await promise` (after line 161): `log("I", myRunId, "perm_resolved", \`tool=${tc.name} approved=${decision.approved} waited=${Date.now() - permStart}ms\`);`
8. Before `Promise.all` tool exec (before line 210): add `const execStart = Date.now();` then `log("I", myRunId, "tool_exec_start", \`count=${approved.length}\`);`
9. After `Promise.all` (after line 254): `log("I", myRunId, "tool_exec_end", \`dur=${Date.now() - execStart}ms\`);`
10. When max iterations reached (after the while loop, before line 267): `log("W", myRunId, "max_iter", \`iter=${iterations - 1}\`);`

**Step 2: Verify existing tests still pass**

Run: `bun test packages/ai/harness/__tests__/agent.test.ts`
Expected: PASS

---

### Task 4: Add logging to the orchestrator

**Files:**
- Modify: `packages/ai/orchestrator.ts`

**Step 1: Add log calls**

Add `import { log } from "./logger";` at top.

Add these log calls:

1. In `spawn()` after `agentId` created (line 83): `log("I", agentId, "agent_spawn", \`model=${params.model}\`);`
2. In `spawnSubagent()` after `agentId` created (line 108): add `const subStart = Date.now();` then `log("I", agentId, "subagent_spawn", \`parent=${parentId}\`);`
3. In `spawnSubagent()` before return (line 132): `log("I", agentId, "subagent_done", \`dur=${Date.now() - subStart}ms\`);`
4. In `events()` when relay stashed (line 191): `log("I", agentId, "relay_stash", \`relay=${event.id} tool=${event.tool}\`);`
5. In `resolveRelay()` when resolved (line 166): `log("I", pending.agentId, "relay_resolve", \`relay=${relayId}\`);`

**Step 2: Verify existing tests still pass**

Run: `bun test packages/ai/__tests__/orchestrator.test.ts`
Expected: PASS

---

### Task 5: Add logging to bash tool

**Files:**
- Modify: `packages/ai/tools/bash.ts`

**Step 1: Add log calls**

Add `import { log } from "../logger";` at top.

The bash tool doesn't have a runId, so use `"-------"` (7 dashes) as the run column — it'll stand out in the CSV as tool-level logging.

Add these log calls inside `execute`:

1. After `spawn()` (after line 40): `log("I", "-------", "bash_start", \`cmd=${JSON.stringify(command).slice(0, 200)}\`);`
2. On successful completion (before line 99 return): `log("I", "-------", "bash_end", \`dur=${Date.now() - start}ms exit=${exitCode}\`);` — need to add `const start = Date.now();` at top of execute.
3. On timeout (before line 85 return): `log("W", "-------", "bash_timeout", \`timeout=${timeout}s cmd=${JSON.stringify(command).slice(0, 200)}\`);`

**Step 2: Verify existing tests still pass**

Run: `bun test packages/ai/tools/bash.test.ts`
Expected: PASS

---

### Task 6: Add logging to server endpoints

**Files:**
- Modify: `server/index.ts`

**Step 1: Add log calls**

Add `import { log } from "../packages/ai/logger.ts";` at top.

Add these log calls:

1. In POST /chat after sessionId created (after line 75): add `const reqStart = Date.now();` then `log("I", sessionId, "req_start", \`model=${model}\`);`
2. In the finally block (line 113): `log("I", sessionId, "req_end", \`dur=${Date.now() - reqStart}ms\`);`

**Step 2: Verify existing tests still pass**

Run: `bun test server/index.test.ts`
Expected: PASS

---

### Task 7: Update .env.example

**Files:**
- Modify: `.env.example`

**Step 1: Add LOG_LEVEL**

Add after the `DEFAULT_MODEL=` line:

```
LOG_LEVEL=I
```

---

### Task 8: Run full test suite and commit

**Step 1: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 2: Format**

Run: `bun run format`

**Step 3: Type check**

Run: `bun run check`

**Step 4: Single commit**

```bash
git add packages/ai/logger.ts packages/ai/logger.test.ts packages/ai/harness/agent.ts packages/ai/harness/providers/zen.ts packages/ai/orchestrator.ts packages/ai/tools/bash.ts server/index.ts .env.example
git commit -m "feat: add CSV logging for debugging agent loop hangs"
```
