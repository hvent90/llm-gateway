# Read & Patch Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `read` and `patch` tools to the agent framework, enabling file reading (text, images, PDFs) and patch-based file mutation with context matching.

**Architecture:** Two new tools (`read`, `patch`) registered alongside `bash` and `agent`. A shared `FileTime` utility tracks file modification times to prevent stale overwrites. Message types extended with `ContentPart` union to support multipart content (images, documents). Each provider harness maps content parts to its provider-specific format.

**Tech Stack:** Bun, Zod (schemas), picomatch (permission globs), bun:test

**Design doc:** `docs/plans/2026-02-02-read-patch-tools-design.md`

---

### Task 1: ContentPart Types

**Files:**
- Modify: `packages/ai/types.ts`
- Test: `packages/ai/__tests__/types.test.ts`

**Step 1: Write the failing test**

Add to `packages/ai/__tests__/types.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import type { ContentPart, Message } from "../types";

describe("ContentPart types", () => {
  test("TextContentPart is assignable to ContentPart", () => {
    const part: ContentPart = { type: "text", text: "hello" };
    expect(part.type).toBe("text");
  });

  test("ImageContentPart is assignable to ContentPart", () => {
    const part: ContentPart = { type: "image", mediaType: "image/png", data: "base64data" };
    expect(part.type).toBe("image");
  });

  test("DocumentContentPart is assignable to ContentPart", () => {
    const part: ContentPart = { type: "document", mediaType: "application/pdf", data: "base64data" };
    expect(part.type).toBe("document");
  });

  test("tool message accepts ContentPart[] as content", () => {
    const msg: Message = {
      role: "tool",
      tool_call_id: "tc-1",
      content: [{ type: "text", text: "result" }],
    };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  test("user message accepts ContentPart[] as content", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", mediaType: "image/png", data: "base64data" },
      ],
    };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  test("user message still accepts plain string content", () => {
    const msg: Message = { role: "user", content: "hello" };
    expect(msg.content).toBe("hello");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/__tests__/types.test.ts`
Expected: TypeScript compilation errors — `ContentPart` doesn't exist, `content` doesn't accept arrays.

**Step 3: Write minimal implementation**

In `packages/ai/types.ts`, add after the imports:

```typescript
// Content part types for multipart messages (images, documents)
export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = { type: "image"; mediaType: string; data: string };
export type DocumentContentPart = { type: "document"; mediaType: string; data: string };
export type ContentPart = TextContentPart | ImageContentPart | DocumentContentPart;
```

Then update the `Message` type — change `user` and `tool` content fields:

```typescript
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string | ContentPart[] };
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/__tests__/types.test.ts`
Expected: PASS

**Step 5: Fix any broken existing tests**

Run: `bun test`
Expected: Some tests may break where code assumes `content` is always a `string` on user/tool messages. Fix those with type narrowing (`typeof msg.content === "string"`). The main places to check:
- `packages/ai/harness/agent.ts:258` — `content: toolContext ?? JSON.stringify(output)` — this already produces a string, so no change needed as `string` is still valid.
- Provider harness `convertMessages` functions — will be updated in Task 7.

**Step 6: Commit**

```bash
git add packages/ai/types.ts packages/ai/__tests__/types.test.ts
git commit -m "feat: add ContentPart types for multipart messages"
```

---

### Task 2: FileTime Utility

**Files:**
- Create: `packages/ai/tools/lib/filetime.ts`
- Create: `packages/ai/tools/lib/__tests__/filetime.test.ts`

**Step 1: Write the failing tests**

Create `packages/ai/tools/lib/__tests__/filetime.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { FileTime } from "../filetime";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("FileTime", () => {
  let ft: FileTime;
  let dir: string;

  beforeEach(() => {
    ft = new FileTime();
    dir = join(tmpdir(), `filetime-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  test("read records mtime for a file", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "hello");
    await ft.read(p);
    // assert should not throw since we just read
    await ft.assert(p);
  });

  test("assert throws when file was never read", async () => {
    const p = join(dir, "b.txt");
    writeFileSync(p, "hello");
    expect(ft.assert(p)).rejects.toThrow("must be read before patching");
  });

  test("assert throws when file was modified externally", async () => {
    const p = join(dir, "c.txt");
    writeFileSync(p, "hello");
    await ft.read(p);

    // Wait a tick then modify — ensure mtime changes
    await Bun.sleep(50);
    writeFileSync(p, "changed");

    expect(ft.assert(p)).rejects.toThrow("modified externally");
  });

  test("assert passes when file is unchanged", async () => {
    const p = join(dir, "d.txt");
    writeFileSync(p, "hello");
    await ft.read(p);
    // No modification — should pass
    await ft.assert(p);
  });

  test("withLock serializes concurrent operations on the same file", async () => {
    const p = join(dir, "e.txt");
    const order: number[] = [];

    const op = (id: number, delay: number) =>
      ft.withLock(p, async () => {
        order.push(id);
        await Bun.sleep(delay);
        order.push(id);
      });

    await Promise.all([op(1, 50), op(2, 10)]);

    // op(1) starts first, op(2) waits. So order is [1, 1, 2, 2]
    expect(order).toEqual([1, 1, 2, 2]);
  });

  test("withLock allows concurrent operations on different files", async () => {
    const p1 = join(dir, "f.txt");
    const p2 = join(dir, "g.txt");
    const order: string[] = [];

    const op = (file: string, id: string, delay: number) =>
      ft.withLock(file, async () => {
        order.push(`${id}-start`);
        await Bun.sleep(delay);
        order.push(`${id}-end`);
      });

    await Promise.all([op(p1, "a", 50), op(p2, "b", 10)]);

    // Both start concurrently, b finishes first
    expect(order[0]).toBe("a-start");
    expect(order[1]).toBe("b-start");
  });

  test("assert throws when file was deleted after read", async () => {
    const p = join(dir, "h.txt");
    writeFileSync(p, "hello");
    await ft.read(p);
    unlinkSync(p);
    expect(ft.assert(p)).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/tools/lib/__tests__/filetime.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

Create `packages/ai/tools/lib/filetime.ts`:

```typescript
import { stat } from "fs/promises";

export class FileTime {
  private times = new Map<string, number>();
  private locks = new Map<string, Promise<void>>();

  /** Record the current mtime for a file. */
  async read(filePath: string): Promise<void> {
    const s = await stat(filePath);
    this.times.set(filePath, s.mtimeMs);
  }

  /**
   * Assert the file has been read and has not been modified since.
   * Throws if never read or if mtime differs.
   */
  async assert(filePath: string): Promise<void> {
    const recorded = this.times.get(filePath);
    if (recorded === undefined) {
      throw new Error(`${filePath} must be read before patching`);
    }
    let current: number;
    try {
      const s = await stat(filePath);
      current = s.mtimeMs;
    } catch {
      throw new Error(`${filePath} was deleted after last read`);
    }
    if (current !== recorded) {
      throw new Error(
        `${filePath} has been modified externally since last read. Please re-read before patching.`,
      );
    }
  }

  /** Serialize operations on the same file path. */
  async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(filePath) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(filePath, next);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/tools/lib/__tests__/filetime.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/tools/lib/filetime.ts packages/ai/tools/lib/__tests__/filetime.test.ts
git commit -m "feat: add FileTime utility for stale-write protection"
```

---

### Task 3: Patch Parser

**Files:**
- Create: `packages/ai/tools/lib/patch-parser.ts`
- Create: `packages/ai/tools/lib/__tests__/patch-parser.test.ts`

**Step 1: Write the failing tests**

Create `packages/ai/tools/lib/__tests__/patch-parser.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { parsePatch } from "../patch-parser";
import type { PatchOp } from "../patch-parser";

describe("parsePatch", () => {
  test("parses AddFile operation", () => {
    const input = `*** Begin Patch
*** Add File: src/new.ts
+export const x = 1;
+export const y = 2;
*** End Patch`;

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("add");
    expect(ops[0].path).toBe("src/new.ts");
    expect((ops[0] as any).content).toBe("export const x = 1;\nexport const y = 2;\n");
  });

  test("parses DeleteFile operation", () => {
    const input = `*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`;

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("delete");
    expect(ops[0].path).toBe("src/old.ts");
  });

  test("parses UpdateFile with single hunk", () => {
    const input = `*** Begin Patch
*** Update File: src/app.ts
@@
 import { Hono } from "hono"
-import { cors } from "hono/cors"
+import { logger } from "hono/logger"

 const app = new Hono()
*** End Patch`;

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("update");
    const update = ops[0] as Extract<PatchOp, { type: "update" }>;
    expect(update.hunks).toHaveLength(1);
    expect(update.hunks[0].contextLines).toContain('import { Hono } from "hono"');
    expect(update.hunks[0].changes).toHaveLength(2);
  });

  test("parses UpdateFile with multiple hunks", () => {
    const input = `*** Begin Patch
*** Update File: src/app.ts
@@
 line one
-old line
+new line
 line three
@@
 line ten
+added line
 line twelve
*** End Patch`;

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    const update = ops[0] as Extract<PatchOp, { type: "update" }>;
    expect(update.hunks).toHaveLength(2);
  });

  test("parses multiple file operations", () => {
    const input = `*** Begin Patch
*** Add File: src/a.ts
+line
*** Delete File: src/b.ts
*** Update File: src/c.ts
@@
 context
-old
+new
*** End Patch`;

    const ops = parsePatch(input);
    expect(ops).toHaveLength(3);
    expect(ops[0].type).toBe("add");
    expect(ops[1].type).toBe("delete");
    expect(ops[2].type).toBe("update");
  });

  test("rejects patch without Begin marker", () => {
    const input = `*** Add File: src/a.ts
+line
*** End Patch`;

    expect(() => parsePatch(input)).toThrow("Begin Patch");
  });

  test("rejects patch without End marker", () => {
    const input = `*** Begin Patch
*** Add File: src/a.ts
+line`;

    expect(() => parsePatch(input)).toThrow("End Patch");
  });

  test("rejects empty hunk in UpdateFile", () => {
    const input = `*** Begin Patch
*** Update File: src/a.ts
@@
*** End Patch`;

    expect(() => parsePatch(input)).toThrow("empty hunk");
  });

  test("rejects AddFile with no content lines", () => {
    const input = `*** Begin Patch
*** Add File: src/a.ts
*** End Patch`;

    expect(() => parsePatch(input)).toThrow();
  });

  test("parses hunk with context hint after @@", () => {
    const input = `*** Begin Patch
*** Update File: src/app.ts
@@ class MyClass
 class MyClass {
-  old() {}
+  new() {}
 }
*** End Patch`;

    const ops = parsePatch(input);
    const update = ops[0] as Extract<PatchOp, { type: "update" }>;
    expect(update.hunks[0].header).toBe("class MyClass");
  });

  test("parses lines with only whitespace prefix as context", () => {
    const input = `*** Begin Patch
*** Update File: src/a.ts
@@
 line one
 line two
-old
+new
 line four
*** End Patch`;

    const ops = parsePatch(input);
    const update = ops[0] as Extract<PatchOp, { type: "update" }>;
    const hunk = update.hunks[0];
    // 4 context lines + 2 changes
    expect(hunk.contextLines.length + hunk.changes.length).toBe(6);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/tools/lib/__tests__/patch-parser.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

Create `packages/ai/tools/lib/patch-parser.ts`:

```typescript
export type HunkLine =
  | { type: "context"; content: string }
  | { type: "add"; content: string }
  | { type: "remove"; content: string };

export interface Hunk {
  header?: string; // optional context hint after @@
  lines: HunkLine[];
  // Derived for convenience:
  contextLines: string[];
  changes: HunkLine[];
}

export type PatchOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; hunks: Hunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const HUNK_START = "@@";

export function parsePatch(input: string): PatchOp[] {
  const rawLines = input.split("\n");
  // Trim trailing empty lines
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") {
    rawLines.pop();
  }

  if (rawLines.length === 0 || rawLines[0].trim() !== BEGIN) {
    throw new Error(`Patch must start with "${BEGIN}"`);
  }
  if (rawLines[rawLines.length - 1].trim() !== END) {
    throw new Error(`Patch must end with "${END}"`);
  }

  const lines = rawLines.slice(1, -1); // strip Begin/End
  const ops: PatchOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith(ADD_FILE)) {
      const path = line.slice(ADD_FILE.length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("+")) {
        contentLines.push(lines[i].slice(1));
        i++;
      }
      if (contentLines.length === 0) {
        throw new Error(`Add File "${path}" has no content lines`);
      }
      ops.push({ type: "add", path, content: contentLines.join("\n") + "\n" });
    } else if (line.startsWith(DELETE_FILE)) {
      const path = line.slice(DELETE_FILE.length).trim();
      ops.push({ type: "delete", path });
      i++;
    } else if (line.startsWith(UPDATE_FILE)) {
      const path = line.slice(UPDATE_FILE.length).trim();
      i++;
      const hunks: Hunk[] = [];

      while (i < lines.length && lines[i].startsWith(HUNK_START)) {
        const headerLine = lines[i];
        const header = headerLine.length > 2 ? headerLine.slice(2).trim() : undefined;
        i++;

        const hunkLines: HunkLine[] = [];
        while (
          i < lines.length &&
          !lines[i].startsWith(HUNK_START) &&
          !lines[i].startsWith("*** ")
        ) {
          const l = lines[i];
          if (l.startsWith("+")) {
            hunkLines.push({ type: "add", content: l.slice(1) });
          } else if (l.startsWith("-")) {
            hunkLines.push({ type: "remove", content: l.slice(1) });
          } else if (l.startsWith(" ") || l === "") {
            // Line starting with space is context; empty line is also context (empty line in file)
            hunkLines.push({ type: "context", content: l === "" ? "" : l.slice(1) });
          } else {
            // Unknown prefix — treat as context (lenient)
            hunkLines.push({ type: "context", content: l });
          }
          i++;
        }

        if (hunkLines.length === 0) {
          throw new Error(`Update File "${path}" has an empty hunk`);
        }

        hunks.push({
          header: header || undefined,
          lines: hunkLines,
          contextLines: hunkLines.filter((l) => l.type === "context").map((l) => l.content),
          changes: hunkLines.filter((l) => l.type !== "context"),
        });
      }

      if (hunks.length === 0) {
        throw new Error(`Update File "${path}" has no hunks`);
      }

      ops.push({ type: "update", path, hunks });
    } else if (line.trim() === "") {
      i++; // skip blank lines between operations
    } else {
      throw new Error(`Unexpected line at position ${i}: "${line}"`);
    }
  }

  return ops;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/tools/lib/__tests__/patch-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/tools/lib/patch-parser.ts packages/ai/tools/lib/__tests__/patch-parser.test.ts
git commit -m "feat: add patch parser for Codex-style patch grammar"
```

---

### Task 4: Patch Applier

**Files:**
- Create: `packages/ai/tools/lib/patch-apply.ts`
- Create: `packages/ai/tools/lib/__tests__/patch-apply.test.ts`

**Step 1: Write the failing tests**

Create `packages/ai/tools/lib/__tests__/patch-apply.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/tools/lib/__tests__/patch-apply.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

Create `packages/ai/tools/lib/patch-apply.ts`:

```typescript
import type { Hunk, HunkLine } from "./patch-parser";

/**
 * Find the starting line index where a hunk's context/remove lines match the file.
 * Returns -1 if no match found.
 */
export function findContextMatch(fileLines: string[], hunk: Hunk): number {
  // Build the sequence of "old" lines (context + remove) that must exist in the file
  const oldLines = hunk.lines
    .filter((l) => l.type === "context" || l.type === "remove")
    .map((l) => l.content);

  if (oldLines.length === 0) {
    // Pure addition — no anchor. Return 0 (prepend) or handle upstream.
    return 0;
  }

  // Slide over fileLines looking for a match
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j] !== oldLines[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }

  return -1;
}

/**
 * Apply a list of hunks to file content. Hunks must be ordered top-to-bottom.
 * Throws if any hunk's context doesn't match.
 */
export function applyHunks(content: string, hunks: Hunk[]): string {
  const hadTrailingNewline = content.endsWith("\n");
  const fileLines = content.split("\n");
  // Remove trailing empty string from split if file ended with newline
  if (hadTrailingNewline && fileLines[fileLines.length - 1] === "") {
    fileLines.pop();
  }

  let offset = 0; // tracks line shift from previous hunk applications

  for (const hunk of hunks) {
    const matchIdx = findContextMatch(fileLines, hunk);
    if (matchIdx === -1) {
      const preview = hunk.lines
        .filter((l) => l.type === "context")
        .slice(0, 3)
        .map((l) => l.content)
        .join(", ");
      throw new Error(
        `Could not find matching context for hunk. Context lines: [${preview}]. ` +
          `Please re-read the file and try again.`,
      );
    }

    // Build replacement: walk hunk lines, keep context and add, skip remove
    const oldLines = hunk.lines
      .filter((l) => l.type === "context" || l.type === "remove")
      .map((l) => l.content);

    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.type === "context" || line.type === "add") {
        newLines.push(line.content);
      }
      // "remove" lines are skipped
    }

    // Splice in the replacement
    fileLines.splice(matchIdx, oldLines.length, ...newLines);

    // Offset adjusts for next hunk (net lines added/removed)
    offset += newLines.length - oldLines.length;
  }

  const result = fileLines.join("\n");
  return hadTrailingNewline ? result + "\n" : result;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/tools/lib/__tests__/patch-apply.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/tools/lib/patch-apply.ts packages/ai/tools/lib/__tests__/patch-apply.test.ts
git commit -m "feat: add hunk context matching and patch application"
```

---

### Task 5: Read Tool

**Files:**
- Create: `packages/ai/tools/read.ts`
- Create: `packages/ai/tools/__tests__/read.test.ts`

**Step 1: Write the failing tests**

Create `packages/ai/tools/__tests__/read.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { readTool } from "../read";
import { FileTime } from "../lib/filetime";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("readTool", () => {
  let dir: string;
  let fileTime: FileTime;

  beforeEach(() => {
    dir = join(tmpdir(), `read-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    fileTime = new FileTime();
  });

  const ctx = () => ({ fileTime });

  test("reads a text file with line numbers", async () => {
    const p = join(dir, "hello.ts");
    writeFileSync(p, "const a = 1;\nconst b = 2;\n");
    const result = await readTool.execute!({ filePath: p }, ctx());
    expect(result.context).toContain("1 |");
    expect(result.context).toContain("const a = 1;");
    expect(result.context).toContain("const b = 2;");
  });

  test("respects offset parameter", async () => {
    const p = join(dir, "offset.ts");
    writeFileSync(p, "line0\nline1\nline2\nline3\n");
    const result = await readTool.execute!({ filePath: p, offset: 2 }, ctx());
    expect(result.context).not.toContain("line0");
    expect(result.context).not.toContain("line1");
    expect(result.context).toContain("line2");
    expect(result.context).toContain("line3");
  });

  test("respects limit parameter", async () => {
    const p = join(dir, "limit.ts");
    writeFileSync(p, "a\nb\nc\nd\ne\n");
    const result = await readTool.execute!({ filePath: p, offset: 0, limit: 2 }, ctx());
    expect(result.context).toContain("a");
    expect(result.context).toContain("b");
    expect(result.context).not.toContain("c");
  });

  test("returns error for non-existent file", async () => {
    const p = join(dir, "nope.ts");
    const result = await readTool.execute!({ filePath: p }, ctx());
    expect(result.context).toContain("not found");
  });

  test("truncates lines longer than 2000 chars", async () => {
    const p = join(dir, "long.ts");
    const longLine = "x".repeat(3000);
    writeFileSync(p, longLine);
    const result = await readTool.execute!({ filePath: p }, ctx());
    expect(result.context).toContain("[truncated]");
  });

  test("returns base64 image for png files", async () => {
    const p = join(dir, "img.png");
    // Write a minimal valid PNG (1x1 pixel)
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(p, png);
    const result = await readTool.execute!({ filePath: p }, ctx());
    expect(result.result).toBeDefined();
    const parts = result.result as any[];
    expect(parts[0].type).toBe("image");
    expect(parts[0].mediaType).toBe("image/png");
    expect(parts[0].data).toBeDefined();
  });

  test("returns base64 document for pdf files", async () => {
    const p = join(dir, "doc.pdf");
    writeFileSync(p, "%PDF-1.4 fake pdf content");
    const result = await readTool.execute!({ filePath: p }, ctx());
    const parts = result.result as any[];
    expect(parts[0].type).toBe("document");
    expect(parts[0].mediaType).toBe("application/pdf");
  });

  test("rejects binary files", async () => {
    const p = join(dir, "data.bin");
    writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const result = await readTool.execute!({ filePath: p }, ctx());
    expect(result.context).toContain("binary");
  });

  test("rejects images over 5MB", async () => {
    const p = join(dir, "big.png");
    writeFileSync(p, Buffer.alloc(6 * 1024 * 1024)); // 6MB
    const result = await readTool.execute!({ filePath: p }, ctx());
    expect(result.context).toContain("5MB");
  });

  test("records FileTime after successful read", async () => {
    const p = join(dir, "tracked.ts");
    writeFileSync(p, "content");
    await readTool.execute!({ filePath: p }, ctx());
    // FileTime.assert should not throw
    await fileTime.assert(p);
  });

  test("does not have derivePermission (reads always allowed)", () => {
    expect(readTool.derivePermission).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/tools/__tests__/read.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

Create `packages/ai/tools/read.ts`:

```typescript
import { z } from "zod";
import { readFile, stat } from "fs/promises";
import { extname } from "path";
import type { ToolDefinition, ToolContext, ContentPart, ImageContentPart, DocumentContentPart } from "../types";
import type { FileTime } from "./lib/filetime";

const schema = z.object({
  filePath: z.string().describe("Absolute path to the file to read"),
  offset: z.number().optional().describe("0-based line number to start reading from"),
  limit: z.number().optional().describe("Maximum number of lines to read (default 2000)"),
});

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

const MAX_LINE_LENGTH = 2000;
const DEFAULT_LIMIT = 2000;
const MAX_TEXT_BYTES = 50 * 1024; // 50KB
const MAX_BINARY_BYTES = 5 * 1024 * 1024; // 5MB

interface ReadToolContext extends ToolContext {
  fileTime: FileTime;
}

function isBinary(buffer: Buffer): boolean {
  // Check first 8KB for null bytes
  const check = buffer.subarray(0, 8192);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

export const readTool: ToolDefinition<typeof schema, ContentPart[]> = {
  name: "read",
  description:
    "Read a file from the filesystem. Returns text with line numbers for code files, " +
    "base64-encoded content for images (png, jpg, gif, webp) and PDFs.",
  schema,
  execute: async ({ filePath, offset = 0, limit = DEFAULT_LIMIT }, ctx) => {
    const { fileTime } = ctx as ReadToolContext;
    const ext = extname(filePath).toLowerCase();

    // Check file exists
    let fileSize: number;
    try {
      const s = await stat(filePath);
      fileSize = s.size;
    } catch {
      return { context: `File not found: ${filePath}` };
    }

    // Handle images
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (fileSize > MAX_BINARY_BYTES) {
        return { context: `Image file exceeds 5MB limit: ${filePath}` };
      }
      const data = await readFile(filePath);
      await fileTime.read(filePath);
      const part: ImageContentPart = {
        type: "image",
        mediaType: MIME_TYPES[ext] || "application/octet-stream",
        data: data.toString("base64"),
      };
      return { context: `Read image: ${filePath}`, result: [part] };
    }

    // Handle PDFs
    if (ext === ".pdf") {
      if (fileSize > MAX_BINARY_BYTES) {
        return { context: `PDF file exceeds 5MB limit: ${filePath}` };
      }
      const data = await readFile(filePath);
      await fileTime.read(filePath);
      const part: DocumentContentPart = {
        type: "document",
        mediaType: "application/pdf",
        data: data.toString("base64"),
      };
      return { context: `Read PDF: ${filePath}`, result: [part] };
    }

    // Handle text files
    const buffer = await readFile(filePath);

    // Check for binary
    if (isBinary(buffer)) {
      return { context: `Cannot read binary file: ${filePath}` };
    }

    const text = buffer.toString("utf-8");
    const allLines = text.split("\n");
    // Remove trailing empty string from split if file ends with newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    const totalLines = allLines.length;
    const sliced = allLines.slice(offset, offset + limit);

    // Truncate long lines and track total bytes
    let totalBytes = 0;
    let truncatedByBytes = false;
    const outputLines: string[] = [];

    for (let i = 0; i < sliced.length; i++) {
      let line = sliced[i];
      if (line.length > MAX_LINE_LENGTH) {
        line = line.slice(0, MAX_LINE_LENGTH) + " [truncated]";
      }
      const lineNum = offset + i + 1; // 1-based display
      const formatted = `${String(lineNum).padStart(4)} | ${line}`;
      totalBytes += formatted.length;
      if (totalBytes > MAX_TEXT_BYTES) {
        truncatedByBytes = true;
        break;
      }
      outputLines.push(formatted);
    }

    const endLine = offset + outputLines.length;
    let output = `<file path="${filePath}" lines="${offset + 1}-${endLine}" total="${totalLines}">\n`;
    output += outputLines.join("\n");
    output += "\n</file>";

    if (truncatedByBytes) {
      output += "\n[Output truncated at 50KB. Use offset/limit to read more.]";
    }

    await fileTime.read(filePath);
    return { context: output };
  },
};
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/tools/__tests__/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/tools/read.ts packages/ai/tools/__tests__/read.test.ts
git commit -m "feat: add read tool with text, image, and PDF support"
```

---

### Task 6: Patch Tool

**Files:**
- Create: `packages/ai/tools/patch.ts`
- Create: `packages/ai/tools/__tests__/patch.test.ts`

**Step 1: Write the failing tests**

Create `packages/ai/tools/__tests__/patch.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { patchTool } from "../patch";
import { FileTime } from "../lib/filetime";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("patchTool", () => {
  let dir: string;
  let fileTime: FileTime;

  beforeEach(() => {
    dir = join(tmpdir(), `patch-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    fileTime = new FileTime();
  });

  const ctx = () => ({ fileTime });

  test("creates a new file with AddFile", async () => {
    const p = join(dir, "new.ts");
    const patch = `*** Begin Patch
*** Add File: ${p}
+export const x = 1;
+export const y = 2;
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(result.context).toContain("Added");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("export const x = 1;\nexport const y = 2;\n");
  });

  test("deletes a file with DeleteFile", async () => {
    const p = join(dir, "delete-me.ts");
    writeFileSync(p, "content");
    await fileTime.read(p);

    const patch = `*** Begin Patch
*** Delete File: ${p}
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(result.context).toContain("Deleted");
    expect(existsSync(p)).toBe(false);
  });

  test("updates a file with UpdateFile hunk", async () => {
    const p = join(dir, "update.ts");
    writeFileSync(p, "line one\nline two\nline three\n");
    await fileTime.read(p);

    const patch = `*** Begin Patch
*** Update File: ${p}
@@
 line one
-line two
+line TWO
 line three
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(result.context).toContain("Updated");
    expect(readFileSync(p, "utf-8")).toBe("line one\nline TWO\nline three\n");
  });

  test("rejects update when file was not read first", async () => {
    const p = join(dir, "unread.ts");
    writeFileSync(p, "content\n");

    const patch = `*** Begin Patch
*** Update File: ${p}
@@
-content
+changed
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(result.context).toContain("must be read");
  });

  test("rejects update when file was modified externally", async () => {
    const p = join(dir, "modified.ts");
    writeFileSync(p, "original\n");
    await fileTime.read(p);

    await Bun.sleep(50);
    writeFileSync(p, "externally changed\n");

    const patch = `*** Begin Patch
*** Update File: ${p}
@@
-original
+patched
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(result.context).toContain("modified externally");
  });

  test("rejects AddFile when file already exists", async () => {
    const p = join(dir, "exists.ts");
    writeFileSync(p, "already here");

    const patch = `*** Begin Patch
*** Add File: ${p}
+new content
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(result.context).toContain("already exists");
  });

  test("rejects UpdateFile when context doesn't match", async () => {
    const p = join(dir, "mismatch.ts");
    writeFileSync(p, "actual content\n");
    await fileTime.read(p);

    const patch = `*** Begin Patch
*** Update File: ${p}
@@
 wrong context
-old
+new
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(result.context).toContain("context");
  });

  test("handles multiple operations in one patch", async () => {
    const p1 = join(dir, "multi-new.ts");
    const p2 = join(dir, "multi-update.ts");
    writeFileSync(p2, "hello\n");
    await fileTime.read(p2);

    const patch = `*** Begin Patch
*** Add File: ${p1}
+new file content
*** Update File: ${p2}
@@
-hello
+goodbye
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(existsSync(p1)).toBe(true);
    expect(readFileSync(p2, "utf-8")).toBe("goodbye\n");
  });

  test("updates FileTime after successful patch", async () => {
    const p = join(dir, "tracked.ts");
    writeFileSync(p, "old\n");
    await fileTime.read(p);

    const patch = `*** Begin Patch
*** Update File: ${p}
@@
-old
+new
*** End Patch`;

    await patchTool.execute!({ patch }, ctx());
    // FileTime should be updated — assert should pass
    await fileTime.assert(p);
  });

  test("has derivePermission that returns glob pattern", () => {
    expect(patchTool.derivePermission).toBeDefined();
    const perm = patchTool.derivePermission!({
      patch: `*** Begin Patch\n*** Update File: /src/app.ts\n@@\n old\n-a\n+b\n*** End Patch`,
    });
    expect(perm.tool).toBe("patch");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/tools/__tests__/patch.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

Create `packages/ai/tools/patch.ts`:

```typescript
import { z } from "zod";
import { readFile, writeFile, unlink, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import type { ToolDefinition, ToolContext, ToolPermission } from "../types";
import type { FileTime } from "./lib/filetime";
import { parsePatch, type PatchOp } from "./lib/patch-parser";
import { applyHunks } from "./lib/patch-apply";

const schema = z.object({
  patch: z.string().describe("The patch to apply, using the patch grammar format"),
});

interface PatchToolContext extends ToolContext {
  fileTime: FileTime;
}

/**
 * Extract all file paths from a patch string for permission derivation.
 */
function extractPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

/**
 * Find the longest common directory prefix from a list of paths.
 */
function commonDir(paths: string[]): string {
  if (paths.length === 0) return "**";
  if (paths.length === 1) return dirname(paths[0]) + "/**";

  const dirs = paths.map((p) => dirname(p).split("/"));
  const common: string[] = [];
  for (let i = 0; i < dirs[0].length; i++) {
    if (dirs.every((d) => d[i] === dirs[0][i])) {
      common.push(dirs[0][i]);
    } else {
      break;
    }
  }
  return (common.length > 0 ? common.join("/") : "") + "/**";
}

export const patchTool: ToolDefinition<typeof schema> = {
  name: "patch",
  description:
    "Apply file changes using a patch. Supports creating new files (Add File), " +
    "deleting files (Delete File), and editing existing files (Update File) with " +
    "context-based hunk matching.",
  schema,
  derivePermission: (params): ToolPermission => {
    const patchText = String(params.patch ?? "");
    const paths = extractPaths(patchText);
    const glob = commonDir(paths);
    return { tool: "patch", params: { patch: glob } };
  },
  execute: async ({ patch: patchText }, ctx) => {
    const { fileTime } = ctx as PatchToolContext;

    // Parse
    let ops: PatchOp[];
    try {
      ops = parsePatch(patchText);
    } catch (e) {
      return { context: `Patch parse error: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Validate and apply each operation
    const results: string[] = [];

    for (const op of ops) {
      try {
        if (op.type === "add") {
          if (existsSync(op.path)) {
            return { context: `File already exists: ${op.path}` };
          }
          await mkdir(dirname(op.path), { recursive: true });
          await writeFile(op.path, op.content);
          await fileTime.read(op.path);
          results.push(`Added ${op.path}`);
        } else if (op.type === "delete") {
          await fileTime.assert(op.path);
          await unlink(op.path);
          results.push(`Deleted ${op.path}`);
        } else if (op.type === "update") {
          await fileTime.assert(op.path);
          await fileTime.withLock(op.path, async () => {
            const content = await readFile(op.path, "utf-8");
            const updated = applyHunks(content, op.hunks);
            await writeFile(op.path, updated);
            await fileTime.read(op.path);
          });
          results.push(`Updated ${op.path}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { context: `Patch failed on ${op.path}: ${msg}` };
      }
    }

    return { context: results.join("\n") };
  },
};
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/tools/__tests__/patch.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/tools/patch.ts packages/ai/tools/__tests__/patch.test.ts
git commit -m "feat: add patch tool with context-matching hunk application"
```

---

### Task 7: Provider Harness ContentPart Mapping

**Files:**
- Modify: `packages/ai/harness/providers/anthropic.ts` (lines 26-93, `convertMessages`)
- Modify: `packages/ai/harness/providers/openai.ts` (lines 22-79, `convertMessages`)
- Modify: `packages/ai/harness/providers/openrouter.ts` (lines 19-33, `convertMessages`)
- Modify: `packages/ai/harness/providers/zen.ts` (lines 17-39, `convertMessages`)

Each harness's `convertMessages` function needs to handle `content: string | ContentPart[]` on user and tool messages.

**Step 1: Write failing tests**

Extend each harness's existing tests (or create new ones) to verify that messages with `ContentPart[]` content are converted correctly. Since these are integration tests that call real APIs, create a focused unit test file:

Create `packages/ai/harness/providers/__tests__/content-parts.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import type { Message, ContentPart } from "../../../types";

// We test the conversion logic by importing each harness's module
// and checking that convertMessages doesn't throw on ContentPart[] messages.
// Since convertMessages is not exported, we test via the harness invoke params.
// These are type-level + smoke tests.

describe("ContentPart message compatibility", () => {
  test("user message with ContentPart[] is valid Message type", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "Look at this image" },
        { type: "image", mediaType: "image/png", data: "base64..." },
      ],
    };
    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
  });

  test("tool message with ContentPart[] is valid Message type", () => {
    const msg: Message = {
      role: "tool",
      tool_call_id: "tc-1",
      content: [
        { type: "text", text: "Read result" },
        { type: "image", mediaType: "image/png", data: "base64..." },
      ],
    };
    expect(msg.role).toBe("tool");
    expect(Array.isArray(msg.content)).toBe(true);
  });
});
```

**Step 2: Run test to verify it passes (type check)**

Run: `bun test packages/ai/harness/providers/__tests__/content-parts.test.ts`
Expected: PASS (types already support this from Task 1).

**Step 3: Update each harness's `convertMessages`**

**Anthropic** (`packages/ai/harness/providers/anthropic.ts`):

Add a helper function and update the user and tool message handling:

```typescript
import type { ContentPart } from "../../types";

function contentPartsToAnthropic(parts: ContentPart[]): ContentBlockParam[] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    } else if (part.type === "image") {
      return {
        type: "image" as const,
        source: { type: "base64" as const, media_type: part.mediaType, data: part.data },
      } as ContentBlockParam;
    } else {
      // document (PDF)
      return {
        type: "document" as const,
        source: { type: "base64" as const, media_type: part.mediaType, data: part.data },
      } as ContentBlockParam;
    }
  });
}
```

In `convertMessages`, update the `user` case:
```typescript
if (msg.role === "user") {
  if (Array.isArray(msg.content)) {
    result.push({ role: "user", content: contentPartsToAnthropic(msg.content) });
  } else {
    result.push({ role: "user", content: msg.content });
  }
}
```

In the `tool` case, when content is an array, convert and merge into the tool_result:
```typescript
if (msg.role === "tool") {
  const toolResult: ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: msg.tool_call_id,
    content: Array.isArray(msg.content)
      ? contentPartsToAnthropic(msg.content)
      : msg.content,
  };
  // ... rest of grouping logic unchanged
}
```

**OpenAI** (`packages/ai/harness/providers/openai.ts`):

Add helper and update user/tool handling. OpenAI uses `image_url` with data URIs:

```typescript
function contentPartsToOpenAI(parts: ContentPart[]): ResponseInputItem.Message["content"] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "input_text" as const, text: part.text };
    } else if (part.type === "image") {
      return {
        type: "input_image" as const,
        image_url: `data:${part.mediaType};base64,${part.data}`,
      };
    } else {
      return { type: "input_file" as const, file_data: `data:${part.mediaType};base64,${part.data}` };
    }
  });
}
```

**OpenRouter** (`packages/ai/harness/providers/openrouter.ts`):

Similar to OpenAI but using the OpenRouter SDK's format.

**Zen** (`packages/ai/harness/providers/zen.ts`):

Zen uses Chat Completions format. Update user messages:

```typescript
if (msg.role === "user") {
  if (Array.isArray(msg.content)) {
    return {
      role: "user",
      content: msg.content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image") {
          return { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
        }
        // PDF — send as text fallback if not supported
        return { type: "text", text: `[PDF document: ${part.mediaType}]` };
      }),
    };
  }
  return { role: msg.role, content: msg.content };
}
```

**Step 4: Run all tests**

Run: `bun test`
Expected: PASS — no regressions. The existing tests pass plain string content which is still valid.

**Step 5: Commit**

```bash
git add packages/ai/harness/providers/anthropic.ts packages/ai/harness/providers/openai.ts packages/ai/harness/providers/openrouter.ts packages/ai/harness/providers/zen.ts packages/ai/harness/providers/__tests__/content-parts.test.ts
git commit -m "feat: add ContentPart mapping to all provider harnesses"
```

---

### Task 8: Wire FileTime Into Orchestrator & Agent

**Files:**
- Modify: `packages/ai/types.ts` (ToolContext)
- Modify: `packages/ai/orchestrator.ts`
- Modify: `packages/ai/harness/agent.ts` (line 235, tool context construction)

**Step 1: Update ToolContext type**

In `packages/ai/types.ts`, update `ToolContext`:

```typescript
import type { FileTime } from "./tools/lib/filetime";

export interface ToolContext {
  parentId?: string;
  spawn?: (task: string) => Promise<string>;
  fileTime?: FileTime;
}
```

**Step 2: Create FileTime in orchestrator**

In `packages/ai/orchestrator.ts`, import and instantiate:

```typescript
import { FileTime } from "./tools/lib/filetime";

export class AgentOrchestrator {
  private fileTime = new FileTime();
  // ... existing fields
```

Pass it through spawn params. Add `fileTime` to the context passed through `GeneratorInvokeParams`:

In the `spawn` method, add `fileTime` to context:
```typescript
context: {
  ...params.context,
  fileTime: this.fileTime,
  spawn: (task: string, parentId: string) => ...
}
```

**Step 3: Pass fileTime to tool context in agent harness**

In `packages/ai/harness/agent.ts`, line 235, where `toolCtx` is constructed:

```typescript
const toolCtx: ToolContext = {
  parentId: nsId(tc.id),
  spawn: params.context?.spawn
    ? (task: string) => params.context!.spawn!(task, nsId(tc.id))
    : undefined,
  fileTime: (params.context as any)?.fileTime,
};
```

Note: We need to add `fileTime` to `GeneratorInvokeParams.context` as well:

In `packages/ai/types.ts`, update `GeneratorInvokeParams`:
```typescript
export interface GeneratorInvokeParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  context?: {
    parentId?: string;
    spawn?: (task: string, parentId: string) => Promise<string>;
    fileTime?: FileTime;
  };
  permissions?: Permissions;
}
```

**Step 4: Run all tests**

Run: `bun test`
Expected: PASS — existing tests don't provide `fileTime` which is optional, so no breakage.

**Step 5: Commit**

```bash
git add packages/ai/types.ts packages/ai/orchestrator.ts packages/ai/harness/agent.ts
git commit -m "feat: wire FileTime through orchestrator and agent harness"
```

---

### Task 9: Register Tools & Full Integration Test

**Files:**
- Modify: wherever tools are registered (check `orchestrator.ts` or `server/index.ts` for tool arrays)
- Create: `packages/ai/tools/__tests__/read-patch-integration.test.ts`

**Step 1: Find where tools are registered**

Check `server/index.ts` and `orchestrator.ts` for where `bashTool` and `agentTool` are imported and assembled into a tools array. Add `readTool` and `patchTool` alongside them.

**Step 2: Write integration test**

Create `packages/ai/tools/__tests__/read-patch-integration.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { readTool } from "../read";
import { patchTool } from "../patch";
import { FileTime } from "../lib/filetime";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("read + patch integration", () => {
  let dir: string;
  let fileTime: FileTime;

  beforeEach(() => {
    dir = join(tmpdir(), `integration-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    fileTime = new FileTime();
  });

  const ctx = () => ({ fileTime });

  test("read then patch round-trip", async () => {
    const p = join(dir, "app.ts");
    writeFileSync(p, 'const greeting = "hello";\nconsole.log(greeting);\n');

    // Read the file
    const readResult = await readTool.execute!({ filePath: p }, ctx());
    expect(readResult.context).toContain("greeting");

    // Patch the file
    const patch = `*** Begin Patch
*** Update File: ${p}
@@
-const greeting = "hello";
+const greeting = "goodbye";
 console.log(greeting);
*** End Patch`;

    const patchResult = await patchTool.execute!({ patch }, ctx());
    expect(patchResult.context).toContain("Updated");

    // Verify the change
    expect(readFileSync(p, "utf-8")).toBe('const greeting = "goodbye";\nconsole.log(greeting);\n');

    // Read again should work (FileTime was updated)
    const readResult2 = await readTool.execute!({ filePath: p }, ctx());
    expect(readResult2.context).toContain("goodbye");
  });

  test("patch without read fails", async () => {
    const p = join(dir, "unread.ts");
    writeFileSync(p, "content\n");

    const patch = `*** Begin Patch
*** Update File: ${p}
@@
-content
+changed
*** End Patch`;

    const result = await patchTool.execute!({ patch }, ctx());
    expect(result.context).toContain("must be read");
  });

  test("create, read, patch, verify", async () => {
    const p = join(dir, "created.ts");

    // Create via patch
    const createPatch = `*** Begin Patch
*** Add File: ${p}
+function hello() {
+  return "world";
+}
*** End Patch`;

    await patchTool.execute!({ patch: createPatch }, ctx());

    // Read it
    const readResult = await readTool.execute!({ filePath: p }, ctx());
    expect(readResult.context).toContain("hello");

    // Update it
    const updatePatch = `*** Begin Patch
*** Update File: ${p}
@@
 function hello() {
-  return "world";
+  return "universe";
 }
*** End Patch`;

    const patchResult = await patchTool.execute!({ patch: updatePatch }, ctx());
    expect(patchResult.context).toContain("Updated");
    expect(readFileSync(p, "utf-8")).toContain("universe");
  });
});
```

**Step 3: Run all tests**

Run: `bun test`
Expected: PASS

**Step 4: Register tools in server**

Add imports and include `readTool` and `patchTool` in the tools array wherever `bashTool` and `agentTool` are listed.

**Step 5: Commit**

```bash
git add packages/ai/tools/__tests__/read-patch-integration.test.ts server/index.ts
git commit -m "feat: register read and patch tools, add integration tests"
```

---

### Task 10: Format & Final Check

**Step 1: Run formatter**

Run: `bun run format`

**Step 2: Run type checker**

Run: `bun run check`

**Step 3: Run full test suite**

Run: `bun test`

**Step 4: Fix any issues found**

Address any formatting, type, or test failures.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: format and fix any remaining issues"
```
