import { describe, test, expect } from "bun:test";
import { createPassthrough } from "../passthrough";

describe("Passthrough", () => {
  test("yields pushed values", async () => {
    const pt = createPassthrough<number>();
    pt.push(1);
    pt.push(2);
    pt.end();

    const values: number[] = [];
    for await (const v of pt.iterable) {
      values.push(v);
    }

    expect(values).toEqual([1, 2]);
  });

  test("waits for push when buffer is empty", async () => {
    const pt = createPassthrough<string>();

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const v of pt.iterable) {
        collected.push(v);
      }
    })();

    pt.push("a");
    pt.push("b");
    pt.end();

    await consumer;
    expect(collected).toEqual(["a", "b"]);
  });

  test("completes iteration on end()", async () => {
    const pt = createPassthrough<number>();
    pt.end();

    const values: number[] = [];
    for await (const v of pt.iterable) {
      values.push(v);
    }

    expect(values).toEqual([]);
  });
});
