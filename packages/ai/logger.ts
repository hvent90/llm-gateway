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
