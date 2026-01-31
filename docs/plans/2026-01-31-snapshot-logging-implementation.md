# Snapshot Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the append-only CSV logger with a snapshot logger that rewrites a compact status file on every log call, showing agent tree + per-agent last 20 events.

**Architecture:** The `log()` function signature stays the same. Internally, it maintains a `Map<string, AgentState>` in memory. On every call, it updates the agent's state and rewrites `logs/gateway.log` with the full snapshot. The agent tree is built from `agent_spawn` and `subagent_spawn` phases. Bash tool log calls are removed (already covered by agent harness `tool_exec_start/end`).

**Tech Stack:** Bun (`Bun.write`), no external dependencies.

---

### Task 1: Rewrite logger tests

**Files:**
- Rewrite: `packages/ai/logger.test.ts`

**Step 1: Write the new tests**

These tests replace the old CSV-based tests. They verify the snapshot format.

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, rmSync, readFileSync } from "fs";
import { log, resetForTesting } from "./logger";

const LOG_FILE = "logs/gateway.log";

beforeEach(() => {
  if (existsSync(LOG_FILE)) rmSync(LOG_FILE);
  resetForTesting();
});

function readLog(): string {
  return readFileSync(LOG_FILE, "utf-8");
}

describe("snapshot logger", () => {
  test("creates agent entry on first log call for a run", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1 max=10");
    const content = readLog();
    expect(content).toContain("=== agents ===");
    expect(content).toContain("aaaa111");
    expect(content).toContain("loop_iter");
  });

  test("tracks agent tree from agent_spawn and subagent_spawn", () => {
    log("I", "aaaa-1111", "agent_spawn", "model=test");
    log("I", "bbbb-2222", "subagent_spawn", "parent=aaaa-1111/tc1");
    const content = readLog();
    // Root agent should appear first
    expect(content).toContain("aaaa111");
    // Sub agent should appear indented after root
    expect(content.indexOf("aaaa111")).toBeLessThan(content.indexOf("bbbb222"));
    expect(content).toContain("├─");
  });

  test("updates phase on subsequent log calls for same run", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1 max=10");
    log("I", "aaaa-1111", "llm_call_start", "model=test");
    const content = readLog();
    // Agent tree should show latest phase
    const agentSection = content.split("=== agents ===")[1]!.split("===")[0]!;
    expect(agentSection).toContain("llm_call_start");
    expect(agentSection).not.toContain("loop_iter");
  });

  test("marks agent as done on no_tools phase", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1 max=10");
    log("I", "aaaa-1111", "no_tools");
    const content = readLog();
    const agentSection = content.split("=== agents ===")[1]!.split("===")[0]!;
    expect(agentSection).toContain("done");
  });

  test("keeps per-agent event buffer with last 20 events", () => {
    for (let i = 0; i < 25; i++) {
      log("I", "aaaa-1111", `phase_${i}`, `i=${i}`);
    }
    const content = readLog();
    // Should have agent's event section
    expect(content).toContain("aaaa111");
    // Should NOT have the first 5 events (evicted from buffer)
    expect(content).not.toContain("phase_0");
    expect(content).not.toContain("phase_4");
    // Should have the last 20
    expect(content).toContain("phase_5");
    expect(content).toContain("phase_24");
  });

  test("marks longest-stuck agent with <<<", () => {
    log("I", "aaaa-1111", "perm_wait", "tool=bash");
    // Simulate time passing by logging other agents
    log("I", "bbbb-2222", "subagent_spawn", "parent=aaaa-1111/tc1");
    log("I", "bbbb-2222", "llm_call_start", "model=test");
    log("I", "bbbb-2222", "no_tools");
    // aaaa is still in perm_wait, bbbb is done
    const content = readLog();
    const agentSection = content.split("=== agents ===")[1]!.split("===")[0]!;
    const lines = agentSection.trim().split("\n");
    const aaaaLine = lines.find((l) => l.includes("aaaa111"))!;
    expect(aaaaLine).toContain("<<<");
  });

  test("per-agent sections are isolated", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1");
    log("I", "bbbb-2222", "loop_iter", "iter=1");
    log("I", "aaaa-1111", "llm_call_end", "dur=100ms");
    const content = readLog();
    // aaaa section should have both events
    const aaaaSection = content.split("=== aaaa111")[1]!.split("===")[0]!;
    expect(aaaaSection).toContain("loop_iter");
    expect(aaaaSection).toContain("llm_call_end");
    // bbbb section should only have its event
    const bbbbSection = content.split("=== bbbb222")[1]!.split("===")[0]!;
    expect(bbbbSection).toContain("loop_iter");
    expect(bbbbSection).not.toContain("llm_call_end");
  });

  test("resetForTesting clears all state", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1");
    resetForTesting();
    if (existsSync(LOG_FILE)) rmSync(LOG_FILE);
    log("I", "bbbb-2222", "loop_iter", "iter=1");
    const content = readLog();
    expect(content).not.toContain("aaaa111");
    expect(content).toContain("bbbb222");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/logger.test.ts`
Expected: FAIL — old logger doesn't produce snapshot format

---

### Task 2: Rewrite the logger implementation

**Files:**
- Rewrite: `packages/ai/logger.ts`

**Step 1: Implement the snapshot logger**

```typescript
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

export type Level = "D" | "I" | "W" | "E";

const LEVEL_ORDER: Record<Level, number> = { D: 0, I: 1, W: 2, E: 3 };
const LOG_DIR = join(import.meta.dir, "../../logs");
const LOG_FILE = join(LOG_DIR, "gateway.log");
const MAX_EVENTS = 20;

const DONE_PHASES = new Set(["no_tools", "req_end", "max_iter", "subagent_done"]);

interface AgentState {
  shortId: string;
  phase: string;
  detail: string;
  phaseStart: number;
  parentShortId: string | null;
  done: boolean;
  events: string[];
}

const agents = new Map<string, AgentState>();
let dirEnsured = false;

function getMinLevel(): Level {
  const env = process.env.LOG_LEVEL;
  if (env === "D" || env === "I" || env === "W" || env === "E") return env;
  return "I";
}

function shortId(run: string): string {
  return run.replace(/-/g, "").slice(0, 7);
}

function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ensureDir(): void {
  if (!dirEnsured) {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  }
}

function parseParentFromDetail(detail: string): string | null {
  const match = detail.match(/parent=([^\s,]+)/);
  if (!match) return null;
  // parent value is like "aaaa-1111/tc1" — extract the run part before the slash
  const parentRun = match[1]!.split("/")[0]!;
  return shortId(parentRun);
}

function getOrCreateAgent(run: string): AgentState {
  const sid = shortId(run);
  let agent = agents.get(sid);
  if (!agent) {
    agent = {
      shortId: sid,
      phase: "",
      detail: "",
      phaseStart: Date.now(),
      parentShortId: null,
      done: false,
      events: [],
    };
    agents.set(sid, agent);
  }
  return agent;
}

function buildTree(): AgentState[] {
  // Find roots (no parent) and build ordered list
  const result: AgentState[] = [];
  const children = new Map<string | null, AgentState[]>();

  for (const agent of agents.values()) {
    const parent = agent.parentShortId;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(agent);
  }

  function walk(parentId: string | null) {
    const kids = children.get(parentId) ?? [];
    for (const kid of kids) {
      result.push(kid);
      walk(kid.shortId);
    }
  }

  walk(null);

  // If some agents weren't reached (no parent link), append them
  for (const agent of agents.values()) {
    if (!result.includes(agent)) result.push(agent);
  }

  return result;
}

function renderSnapshot(): string {
  const now = Date.now();
  const tree = buildTree();
  if (tree.length === 0) return "";

  // Find the agent stuck longest (not done)
  let maxStuckId: string | null = null;
  let maxStuckDur = 0;
  for (const agent of tree) {
    if (!agent.done) {
      const dur = now - agent.phaseStart;
      if (dur > maxStuckDur) {
        maxStuckDur = dur;
        maxStuckId = agent.shortId;
      }
    }
  }

  const lines: string[] = ["=== agents ==="];

  for (let i = 0; i < tree.length; i++) {
    const agent = tree[i]!;
    const isChild = agent.parentShortId !== null;
    const isLast =
      isChild &&
      !tree.slice(i + 1).some((a) => a.parentShortId === agent.parentShortId);
    const prefix = isChild ? (isLast ? "└─" : "├─") : "";
    const phase = agent.done ? "done" : agent.phase;
    const dur = formatDuration(now - agent.phaseStart);
    const detail = agent.detail ? `  ${agent.detail}` : "";
    const stuck = !agent.done && agent.shortId === maxStuckId && tree.filter((a) => !a.done).length > 1 ? "  <<<" : "";
    lines.push(`${agent.shortId} ${prefix}${phase}${detail}  ${dur}${stuck}`);
  }

  // Per-agent event sections
  for (const agent of tree) {
    const label = agent.parentShortId === null ? "root" : "sub";
    lines.push("");
    lines.push(`=== ${agent.shortId} (${label}) last ${MAX_EVENTS} ===`);
    for (const event of agent.events) {
      lines.push(event);
    }
  }

  return lines.join("\n") + "\n";
}

function writeSnapshot(): void {
  ensureDir();
  writeFileSync(LOG_FILE, renderSnapshot());
}

export function log(level: Level, run: string, phase: string, detail?: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinLevel()]) return;

  // Skip the bash tool's "-------" placeholder — these are covered by agent harness
  if (run === "-------") return;

  const agent = getOrCreateAgent(run);
  agent.phase = phase;
  agent.detail = detail ?? "";
  agent.phaseStart = Date.now();

  if (DONE_PHASES.has(phase)) agent.done = true;

  // Handle parent tracking
  if (phase === "subagent_spawn" && detail) {
    agent.parentShortId = parseParentFromDetail(detail);
  }
  if (phase === "agent_spawn") {
    agent.parentShortId = null; // explicit root
  }

  // Push to event buffer (circular)
  const eventLine = `${formatTime()},${phase}${detail ? "," + detail : ""}`;
  agent.events.push(eventLine);
  if (agent.events.length > MAX_EVENTS) {
    agent.events.shift();
  }

  writeSnapshot();
}

export function resetForTesting(): void {
  agents.clear();
  dirEnsured = false;
}
```

**Step 2: Run tests to verify they pass**

Run: `bun test packages/ai/logger.test.ts`
Expected: All PASS

---

### Task 3: Remove bash tool log calls

**Files:**
- Modify: `packages/ai/tools/bash.ts`

**Step 1: Remove the import and all log calls**

Remove `import { log } from "../logger";` from the top.

Remove these 3 log calls:
- Line 37: `log("I", "-------", "bash_start", ...)`
- Lines 88-93: `log("W", "-------", "bash_timeout", ...)`
- Line 102: `log("I", "-------", "bash_end", ...)`

Also remove `const bashStart = Date.now();` on line 36 (no longer needed).

The resulting execute function should start directly with:
```typescript
execute: async ({ command, timeout }) => {
    const proc = spawn({
```

**Step 2: Verify bash tests still pass**

Run: `bun test packages/ai/tools/bash.test.ts`
Expected: All PASS

---

### Task 4: Run full test suite, format, and commit

**Step 1: Format**

Run: `bun run format`

**Step 2: Run key tests**

Run: `bun test packages/ai/logger.test.ts packages/ai/tools/bash.test.ts packages/ai/harness/__tests__/agent.test.ts`
Expected: All PASS

**Step 3: Single commit**

```bash
git add packages/ai/logger.ts packages/ai/logger.test.ts packages/ai/tools/bash.ts
git commit -m "feat: replace CSV log with snapshot log for compact agent tracing"
```
