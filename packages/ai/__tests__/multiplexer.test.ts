import { describe, it, expect } from "bun:test";
import { AgentMultiplexer, type MultiplexedEvent } from "../multiplexer";
import { createPassthrough } from "../primitives";

/**
 * Helper to create a simple async generator from an array of values.
 */
async function* fromArray<T>(values: T[]): AsyncGenerator<T, void, unknown> {
  for (const value of values) {
    yield value;
  }
}

describe("AgentMultiplexer", () => {
  describe("basic registration and event streaming", () => {
    it("yields events from a single registered agent", async () => {
      const multiplexer = new AgentMultiplexer<number>();

      multiplexer.register("agent1", fromArray([1, 2, 3]));

      const events: MultiplexedEvent<number>[] = [];
      for await (const event of multiplexer.events()) {
        events.push(event);
      }

      expect(events).toEqual([
        { agentId: "agent1", event: 1 },
        { agentId: "agent1", event: 2 },
        { agentId: "agent1", event: 3 },
      ]);
    });

    it("yields events from multiple agents concurrently", async () => {
      const multiplexer = new AgentMultiplexer<string>();

      multiplexer.register("a", fromArray(["a1", "a2"]));
      multiplexer.register("b", fromArray(["b1", "b2"]));

      const events: MultiplexedEvent<string>[] = [];
      for await (const event of multiplexer.events()) {
        events.push(event);
      }

      // Should have all 4 events
      expect(events.length).toBe(4);

      // All agent A events should be present and in order
      const aEvents = events.filter((e) => e.agentId === "a");
      expect(aEvents.map((e) => e.event)).toEqual(["a1", "a2"]);

      // All agent B events should be present and in order
      const bEvents = events.filter((e) => e.agentId === "b");
      expect(bEvents.map((e) => e.event)).toEqual(["b1", "b2"]);
    });

    it("completes when all agents are done", async () => {
      const multiplexer = new AgentMultiplexer<number>();

      multiplexer.register("x", fromArray([1]));
      multiplexer.register("y", fromArray([2]));

      const events: MultiplexedEvent<number>[] = [];
      for await (const event of multiplexer.events()) {
        events.push(event);
      }

      // Loop should complete - if it doesn't, this test hangs
      expect(events.length).toBe(2);
    });
  });

  describe("pause and resume", () => {
    it("pausing agent A does not block agent B", async () => {
      const multiplexer = new AgentMultiplexer<string>();

      // Agent A: never ends until unregistered
      let aYieldCount = 0;
      async function* agentA(): AsyncGenerator<string, void, unknown> {
        yield "a1";
        aYieldCount++;
        // Wait forever (simulates a paused/blocked agent)
        await new Promise(() => {});
      }

      // Agent B: immediate values
      multiplexer.register("a", agentA());
      multiplexer.register("b", fromArray(["b1", "b2", "b3"]));

      // Let agent A yield its first value
      await new Promise((r) => setTimeout(r, 10));

      // Pause agent A after its first yield
      multiplexer.pause("a");

      // Collect events with timeout
      const events: MultiplexedEvent<string>[] = [];
      const iterator = multiplexer.events()[Symbol.asyncIterator]();

      // Collect up to 10 events or timeout after 500ms
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const result = await Promise.race([
          iterator.next(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), 100),
          ),
        ]);
        if (result.done) break;
        events.push(result.value);
        if (events.length >= 4) break;
      }

      // Should have a1 plus all B events
      const bEvents = events.filter((e) => e.agentId === "b");
      expect(bEvents.length).toBe(3);
      expect(bEvents.map((e) => e.event)).toEqual(["b1", "b2", "b3"]);

      // Clean up
      multiplexer.unregister("a");
    });

    it("resume allows paused agent to continue", async () => {
      const multiplexer = new AgentMultiplexer<number>();

      multiplexer.register("agent", fromArray([1, 2, 3]));

      const iterator = multiplexer.events()[Symbol.asyncIterator]();

      // Get first event
      const first = await iterator.next();
      expect(first.value).toEqual({ agentId: "agent", event: 1 });

      // Pause
      multiplexer.pause("agent");

      // Resume
      multiplexer.resume("agent");

      // Should be able to get remaining events
      const second = await iterator.next();
      expect(second.value).toEqual({ agentId: "agent", event: 2 });

      const third = await iterator.next();
      expect(third.value).toEqual({ agentId: "agent", event: 3 });

      const done = await iterator.next();
      expect(done.done).toBe(true);
    });
  });

  describe("unregister", () => {
    it("removes agent from multiplexer", async () => {
      const multiplexer = new AgentMultiplexer<number>();

      multiplexer.register("agent1", fromArray([1, 2, 3]));
      multiplexer.register("agent2", fromArray([4, 5, 6]));

      // Unregister agent1 immediately
      multiplexer.unregister("agent1");

      const events: MultiplexedEvent<number>[] = [];
      for await (const event of multiplexer.events()) {
        events.push(event);
      }

      // Should only have agent2 events
      expect(events.every((e) => e.agentId === "agent2")).toBe(true);
      expect(events.map((e) => e.event)).toEqual([4, 5, 6]);
    });

    it("calls iterator.return() on unregister for cleanup", async () => {
      const multiplexer = new AgentMultiplexer<number>();

      let returnCalled = false;

      // Custom async iterable that tracks return() call
      const iterable: AsyncIterable<number> = {
        [Symbol.asyncIterator](): AsyncIterator<number> {
          let count = 0;
          return {
            async next() {
              if (count >= 10) return { done: true, value: undefined };
              count++;
              // Slow iterator to give time to unregister
              await new Promise((r) => setTimeout(r, 50));
              return { done: false, value: count };
            },
            return() {
              returnCalled = true;
              return Promise.resolve({ done: true as const, value: undefined });
            },
          };
        },
      };

      multiplexer.register("agent", iterable);

      // Let it start
      await new Promise((r) => setTimeout(r, 10));

      // Unregister
      multiplexer.unregister("agent");

      expect(returnCalled).toBe(true);
    });

    it("handles unregistering non-existent agent gracefully", () => {
      const multiplexer = new AgentMultiplexer<number>();

      // Should not throw
      expect(() => multiplexer.unregister("nonexistent")).not.toThrow();
    });
  });

  describe("edge cases", () => {
    it("handles registering while events() is iterating", async () => {
      const multiplexer = new AgentMultiplexer<string>();

      multiplexer.register("first", fromArray(["a", "b"]));

      const events: MultiplexedEvent<string>[] = [];
      let count = 0;

      for await (const event of multiplexer.events()) {
        events.push(event);
        count++;
        if (count === 1) {
          // Register new agent mid-stream
          multiplexer.register("second", fromArray(["x", "y"]));
        }
      }

      // Should have events from both agents
      expect(events.length).toBe(4);
      expect(events.some((e) => e.agentId === "second")).toBe(true);
    });

    it("handles pausing non-existent agent gracefully", () => {
      const multiplexer = new AgentMultiplexer<number>();

      // Should not throw
      expect(() => multiplexer.pause("nonexistent")).not.toThrow();
    });

    it("handles resuming non-existent agent gracefully", () => {
      const multiplexer = new AgentMultiplexer<number>();

      // Should not throw
      expect(() => multiplexer.resume("nonexistent")).not.toThrow();
    });

    it("handles empty multiplexer", async () => {
      const multiplexer = new AgentMultiplexer<number>();

      const events: MultiplexedEvent<number>[] = [];
      for await (const event of multiplexer.events()) {
        events.push(event);
      }

      expect(events).toEqual([]);
    });

    it("yields events from agent registered while Promise.race is in progress", async () => {
      // Reproduces the nested subagent deadlock from the real orchestrator:
      //
      // In the real code, the parent agent's events flow through a passthrough.
      // The spawnSubagent() loop drives the harness generator and pushes events
      // into the passthrough. When tool execution spawns a child, it calls
      // mux.register() for the child. This happens ASYNCHRONOUSLY — not inside
      // the passthrough's next() call. So the mux is already in Promise.race
      // on the parent's passthrough when the child is registered.
      //
      // The child produces events that must be consumed before the parent
      // can continue (the parent is awaiting the child's completion).
      // This creates a deadlock: mux races on parentPending, child events
      // can't be consumed, parent can't resolve.

      const mux = new AgentMultiplexer<string>();
      const parentPt = createPassthrough<string>();
      const childPt = createPassthrough<string>();

      mux.register("parent", parentPt.iterable);

      const iterator = mux.events()[Symbol.asyncIterator]();

      // Push first event from parent
      parentPt.push("parent-1");
      const first = await iterator.next();
      expect(first.value).toEqual({ agentId: "parent", event: "parent-1" });

      // At this point the mux generator has yielded parent-1 and is suspended.
      // When we call iterator.next() again, it will:
      // 1. Resume the generator from the yield
      // 2. Call pull("parent") — parentPt has no buffered values, so parentPending blocks
      // 3. Collect racing = [parentPending] and enter Promise.race
      //
      // We need the child registration to happen AFTER Promise.race starts.
      // We use a microtask to ensure the registration happens after the
      // synchronous part of iterator.next() completes.

      // Schedule child registration for after the mux enters Promise.race
      setTimeout(() => {
        mux.register("child", childPt.iterable);
        childPt.push("child-1");
        childPt.end();
      }, 10);

      // This iterator.next() call enters Promise.race([parentPending]).
      // The child registration happens 10ms later, but the mux is stuck
      // racing only on parentPending.
      const second = await Promise.race([
        iterator.next(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
      ]);

      // The child event must come through even though parent is blocked
      expect(second).not.toBe("timeout");
      expect((second as IteratorResult<MultiplexedEvent<string>>).value).toEqual({
        agentId: "child",
        event: "child-1",
      });

      // Now resolve parent
      parentPt.push("parent-2");
      parentPt.end();

      const third = await iterator.next();
      expect(third.value).toEqual({ agentId: "parent", event: "parent-2" });

      const done = await iterator.next();
      expect(done.done).toBe(true);
    });

    it("preserves event order per agent", async () => {
      const multiplexer = new AgentMultiplexer<number>();

      // Create agents with sequential numbers
      multiplexer.register("a", fromArray([1, 2, 3, 4, 5]));
      multiplexer.register("b", fromArray([10, 20, 30, 40, 50]));

      const events: MultiplexedEvent<number>[] = [];
      for await (const event of multiplexer.events()) {
        events.push(event);
      }

      // Events from each agent should maintain their order
      const aEvents = events.filter((e) => e.agentId === "a").map((e) => e.event);
      const bEvents = events.filter((e) => e.agentId === "b").map((e) => e.event);

      expect(aEvents).toEqual([1, 2, 3, 4, 5]);
      expect(bEvents).toEqual([10, 20, 30, 40, 50]);
    });
  });
});
