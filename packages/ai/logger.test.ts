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

describe("logger", () => {
  test("creates log file with CSV header on first write", () => {
    log("I", "abc1234-rest-of-uuid", "test_phase", "key=value");
    const lines = readLog().trimEnd().split("\n");
    expect(lines[0]).toBe("time,level,run,phase,detail");
    expect(lines.length).toBe(2);
  });

  test("truncates runId to 7 chars", () => {
    log("I", "0195e5a0-1234-7000-8000-000000000000", "test_phase");
    const dataLine = readLog().trimEnd().split("\n")[1]!;
    const run = dataLine.split(",")[2];
    expect(run).toBe("0195e5a");
  });

  test("formats time as HH:MM:SS.mmm", () => {
    log("I", "abc1234", "test_phase");
    const dataLine = readLog().trimEnd().split("\n")[1]!;
    const time = dataLine.split(",")[0];
    expect(time).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  test("filters DEBUG when LOG_LEVEL is I", () => {
    log("D", "abc1234", "debug_phase");
    const content = readLog();
    expect(content.trimEnd().split("\n").length).toBe(1);
  });

  test("CSV-quotes detail containing commas", () => {
    log("I", "abc1234", "test_phase", 'key=value1,value2 other="stuff"');
    const dataLine = readLog().trimEnd().split("\n")[1];
    expect(dataLine).toContain('"key=value1,value2 other=""stuff"""');
  });

  test("handles empty detail", () => {
    log("I", "abc1234", "no_tools");
    const dataLine = readLog().trimEnd().split("\n")[1];
    expect(dataLine).toMatch(/,no_tools,$/);
  });
});
