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
