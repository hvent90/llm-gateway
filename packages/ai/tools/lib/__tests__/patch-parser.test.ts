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
    // 3 context lines + 2 changes
    expect(hunk.contextLines.length + hunk.changes.length).toBe(5);
  });
});
