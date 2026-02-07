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
  return run.replace(/-/g, "").slice(-7);
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
  let maxStuckDur = -1;
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
      isChild && !tree.slice(i + 1).some((a) => a.parentShortId === agent.parentShortId);
    const prefix = isChild ? (isLast ? "└─" : "├─") : "";
    const phase = agent.done ? "done" : agent.phase;
    const dur = formatDuration(now - agent.phaseStart);
    const detail = agent.detail ? `  ${agent.detail}` : "";
    const stuck =
      !agent.done && agent.shortId === maxStuckId && tree.filter((a) => !a.done).length > 1
        ? "  <<<"
        : "";
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
  try {
    writeFileSync(LOG_FILE, renderSnapshot());
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      dirEnsured = false;
      ensureDir();
      writeFileSync(LOG_FILE, renderSnapshot());
    }
  }
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
