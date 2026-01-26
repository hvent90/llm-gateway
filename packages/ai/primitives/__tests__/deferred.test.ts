import { describe, it, expect } from "bun:test";
import { deferred } from "../deferred";

describe("deferred", () => {
  it("returns a promise that can be resolved externally", async () => {
    const d = deferred<string>();

    // Resolve from outside
    d.resolve("hello");

    const result = await d.promise;
    expect(result).toBe("hello");
  });

  it("returns a promise that can be rejected externally", async () => {
    const d = deferred<string>();

    // Reject from outside
    d.reject(new Error("test error"));

    await expect(d.promise).rejects.toThrow("test error");
  });

  it("allows multiple awaits on the same promise", async () => {
    const d = deferred<number>();

    // Set up multiple consumers
    const promise1 = d.promise;
    const promise2 = d.promise;
    const promise3 = d.promise;

    // Resolve once
    d.resolve(42);

    // All should receive the same value
    const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);
    expect(r1).toBe(42);
    expect(r2).toBe(42);
    expect(r3).toBe(42);
  });

  it("can be resolved before being awaited", async () => {
    const d = deferred<string>();

    // Resolve first
    d.resolve("pre-resolved");

    // Then await
    const result = await d.promise;
    expect(result).toBe("pre-resolved");
  });

  it("handles async resolution timing correctly", async () => {
    const d = deferred<number>();
    const results: number[] = [];

    // Start waiting
    const waitPromise = d.promise.then((v) => {
      results.push(v);
    });

    // Resolve after a microtask
    await Promise.resolve();
    d.resolve(100);

    await waitPromise;
    expect(results).toEqual([100]);
  });

  it("only uses first resolve/reject", async () => {
    const d = deferred<string>();

    d.resolve("first");
    d.resolve("second"); // Should be ignored
    d.reject(new Error("should be ignored"));

    const result = await d.promise;
    expect(result).toBe("first");
  });
});
