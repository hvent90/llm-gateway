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
    expect(result.context).toContain("| a");
    expect(result.context).toContain("| b");
    expect(result.context).not.toContain("| c");
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
