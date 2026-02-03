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
