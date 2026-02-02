import { describe, test, expect } from "bun:test";
import { applyHunks, findContextMatch } from "../patch-apply";
import type { Hunk, HunkLine } from "../patch-parser";

function makeHunk(lines: HunkLine[], header?: string): Hunk {
  return {
    header,
    lines,
    contextLines: lines.filter((l) => l.type === "context").map((l) => l.content),
    changes: lines.filter((l) => l.type !== "context"),
  };
}

describe("findContextMatch", () => {
  const fileLines = [
    "import { Hono } from 'hono'",
    "import { cors } from 'hono/cors'",
    "",
    "const app = new Hono()",
    "app.get('/', (c) => c.text('hello'))",
  ];

  test("finds exact context match", () => {
    const hunk = makeHunk([
      { type: "context", content: "import { Hono } from 'hono'" },
      { type: "remove", content: "import { cors } from 'hono/cors'" },
      { type: "add", content: "import { logger } from 'hono/logger'" },
    ]);
    const idx = findContextMatch(fileLines, hunk);
    expect(idx).toBe(0);
  });

  test("finds match with context before and after", () => {
    const hunk = makeHunk([
      { type: "context", content: "" },
      { type: "context", content: "const app = new Hono()" },
      { type: "remove", content: "app.get('/', (c) => c.text('hello'))" },
      { type: "add", content: "app.get('/', (c) => c.json({ msg: 'hello' }))" },
    ]);
    const idx = findContextMatch(fileLines, hunk);
    expect(idx).toBe(2); // starts at the empty line
  });

  test("returns -1 when context doesn't match", () => {
    const hunk = makeHunk([
      { type: "context", content: "this line does not exist" },
      { type: "remove", content: "nor this" },
    ]);
    const idx = findContextMatch(fileLines, hunk);
    expect(idx).toBe(-1);
  });
});

describe("applyHunks", () => {
  test("applies a single hunk with add and remove", () => {
    const original = "line one\nline two\nline three\n";
    const hunk = makeHunk([
      { type: "context", content: "line one" },
      { type: "remove", content: "line two" },
      { type: "add", content: "line TWO" },
      { type: "context", content: "line three" },
    ]);
    const result = applyHunks(original, [hunk]);
    expect(result).toBe("line one\nline TWO\nline three\n");
  });

  test("applies multiple hunks top to bottom", () => {
    const original = "a\nb\nc\nd\ne\nf\n";
    const hunk1 = makeHunk([
      { type: "context", content: "a" },
      { type: "remove", content: "b" },
      { type: "add", content: "B" },
      { type: "context", content: "c" },
    ]);
    const hunk2 = makeHunk([
      { type: "context", content: "d" },
      { type: "remove", content: "e" },
      { type: "add", content: "E" },
      { type: "context", content: "f" },
    ]);
    const result = applyHunks(original, [hunk1, hunk2]);
    expect(result).toBe("a\nB\nc\nd\nE\nf\n");
  });

  test("applies hunk that only adds lines", () => {
    const original = "a\nb\n";
    const hunk = makeHunk([
      { type: "context", content: "a" },
      { type: "add", content: "inserted" },
      { type: "context", content: "b" },
    ]);
    const result = applyHunks(original, [hunk]);
    expect(result).toBe("a\ninserted\nb\n");
  });

  test("applies hunk that only removes lines", () => {
    const original = "a\nb\nc\n";
    const hunk = makeHunk([
      { type: "context", content: "a" },
      { type: "remove", content: "b" },
      { type: "context", content: "c" },
    ]);
    const result = applyHunks(original, [hunk]);
    expect(result).toBe("a\nc\n");
  });

  test("throws when context doesn't match", () => {
    const original = "a\nb\nc\n";
    const hunk = makeHunk([
      { type: "context", content: "x" },
      { type: "remove", content: "y" },
    ]);
    expect(() => applyHunks(original, [hunk])).toThrow("context");
  });

  test("handles file with no trailing newline", () => {
    const original = "a\nb\nc";
    const hunk = makeHunk([
      { type: "context", content: "a" },
      { type: "remove", content: "b" },
      { type: "add", content: "B" },
      { type: "context", content: "c" },
    ]);
    const result = applyHunks(original, [hunk]);
    expect(result).toBe("a\nB\nc");
  });
});
