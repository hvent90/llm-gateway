import { describe, it, expect } from "bun:test";
import { AsyncQueue } from "../async-queue";

describe("AsyncQueue", () => {
  describe("ordering guarantees", () => {
    it("pops items in FIFO order", async () => {
      const queue = new AsyncQueue<number>();

      queue.push(1);
      queue.push(2);
      queue.push(3);

      expect(await queue.pop()).toBe(1);
      expect(await queue.pop()).toBe(2);
      expect(await queue.pop()).toBe(3);
    });

    it("maintains order with interleaved push/pop", async () => {
      const queue = new AsyncQueue<string>();

      queue.push("a");
      expect(await queue.pop()).toBe("a");

      queue.push("b");
      queue.push("c");
      expect(await queue.pop()).toBe("b");

      queue.push("d");
      expect(await queue.pop()).toBe("c");
      expect(await queue.pop()).toBe("d");
    });
  });

  describe("async waiting behavior", () => {
    it("pop waits when queue is empty", async () => {
      const queue = new AsyncQueue<number>();
      const results: number[] = [];

      // Start waiting before any push
      const popPromise = queue.pop().then((v) => {
        results.push(v);
      });

      // Verify nothing received yet
      expect(results).toEqual([]);

      // Now push
      queue.push(42);

      await popPromise;
      expect(results).toEqual([42]);
    });

    it("multiple pops wait and receive in order", async () => {
      const queue = new AsyncQueue<number>();
      const results: number[] = [];

      // Set up multiple waiting consumers
      const p1 = queue.pop().then((v) => results.push(v));
      const p2 = queue.pop().then((v) => results.push(v));
      const p3 = queue.pop().then((v) => results.push(v));

      // Push values
      queue.push(1);
      queue.push(2);
      queue.push(3);

      await Promise.all([p1, p2, p3]);

      // First pop should get first push, etc.
      expect(results).toEqual([1, 2, 3]);
    });

    it("handles push while waiters are pending", async () => {
      const queue = new AsyncQueue<string>();

      // Start waiting
      const promise = queue.pop();

      // Push resolves the waiter immediately
      queue.push("value");

      const result = await promise;
      expect(result).toBe("value");
    });
  });

  describe("edge cases", () => {
    it("handles empty pop followed by push", async () => {
      const queue = new AsyncQueue<number>();

      // Pop on empty queue
      const popPromise = queue.pop();

      // Should not be resolved yet
      let resolved = false;
      popPromise.then(() => {
        resolved = true;
      });

      await Promise.resolve(); // Allow microtask
      expect(resolved).toBe(false);

      // Now push
      queue.push(123);

      const result = await popPromise;
      expect(result).toBe(123);
    });

    it("handles multiple pushes with no pops", async () => {
      const queue = new AsyncQueue<number>();

      queue.push(1);
      queue.push(2);
      queue.push(3);
      queue.push(4);
      queue.push(5);

      expect(queue.length).toBe(5);

      // Now pop all
      expect(await queue.pop()).toBe(1);
      expect(await queue.pop()).toBe(2);
      expect(await queue.pop()).toBe(3);
      expect(await queue.pop()).toBe(4);
      expect(await queue.pop()).toBe(5);

      expect(queue.length).toBe(0);
    });

    it("length reflects queued items not waiting consumers", async () => {
      const queue = new AsyncQueue<number>();

      expect(queue.length).toBe(0);

      queue.push(1);
      expect(queue.length).toBe(1);

      queue.push(2);
      expect(queue.length).toBe(2);

      await queue.pop();
      expect(queue.length).toBe(1);

      await queue.pop();
      expect(queue.length).toBe(0);

      // Start waiting - length stays at 0
      const promise = queue.pop();
      expect(queue.length).toBe(0);

      queue.push(3);
      await promise;
      expect(queue.length).toBe(0);
    });

    it("handles undefined values correctly", async () => {
      const queue = new AsyncQueue<number | undefined>();

      queue.push(undefined);
      queue.push(1);
      queue.push(undefined);

      expect(await queue.pop()).toBe(undefined);
      expect(await queue.pop()).toBe(1);
      expect(await queue.pop()).toBe(undefined);
    });

    it("handles null values correctly", async () => {
      const queue = new AsyncQueue<string | null>();

      queue.push(null);
      queue.push("value");
      queue.push(null);

      expect(await queue.pop()).toBe(null);
      expect(await queue.pop()).toBe("value");
      expect(await queue.pop()).toBe(null);
    });

    it("handles rapid push/pop cycles", async () => {
      const queue = new AsyncQueue<number>();
      const results: number[] = [];

      // Create interleaved push/pop
      for (let i = 0; i < 100; i++) {
        queue.push(i);
      }

      for (let i = 0; i < 100; i++) {
        results.push(await queue.pop());
      }

      // Verify all values received in order
      expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });

    it("concurrent pops resolve in order of pop call", async () => {
      const queue = new AsyncQueue<number>();
      const order: number[] = [];

      // Multiple concurrent pops
      const p1 = queue.pop().then(() => order.push(1));
      const p2 = queue.pop().then(() => order.push(2));
      const p3 = queue.pop().then(() => order.push(3));

      // Push one at a time
      queue.push(10);
      await p1;

      queue.push(20);
      await p2;

      queue.push(30);
      await p3;

      expect(order).toEqual([1, 2, 3]);
    });
  });
});
