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
