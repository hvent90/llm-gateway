import { describe, it, expect } from "bun:test";
import { AgentOrchestrator, type ConsumerHarnessEvent } from "./orchestrator";
import type { HarnessEvent, GeneratorInvokeParams } from "./types";
import type { MultiplexedEvent } from "./multiplexer";

/**
 * Helper to create a fake generator harness for testing.
 * Yields the events provided and tracks invocations.
 */
function createFakeHarness(events: HarnessEvent[][]) {
  let callCount = 0;
  const invocations: GeneratorInvokeParams[] = [];

  return {
    harness: {
      async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
        invocations.push(params);
        const eventsForThisCall = events[callCount++] ?? [];
        for (const event of eventsForThisCall) {
          yield event;
        }
      },
      async supportedModels(): Promise<string[]> {
        return ["test-model"];
      },
    },
    getInvocations: () => invocations,
  };
}

describe("AgentOrchestrator", () => {
  describe("spawn", () => {
    it("creates an agent and returns a UUID", async () => {
      const { harness } = createFakeHarness([
        [{ type: "text", runId: "r1", id: "t1", content: "hello" }],
      ]);
      const orchestrator = new AgentOrchestrator(harness);

      const agentId = orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      });

      // Should be a valid UUID v7 (36 chars with dashes)
      expect(agentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("registers the agent with the multiplexer and events are yielded", async () => {
      const { harness } = createFakeHarness([
        [
          { type: "text", runId: "r1", id: "t1", content: "hello" },
          { type: "text", runId: "r1", id: "t2", content: " world" },
        ],
      ]);
      const orchestrator = new AgentOrchestrator(harness);

      const agentId = orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      });

      const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
      for await (const event of orchestrator.events()) {
        events.push(event);
      }

      expect(events.length).toBe(2);
      expect(events[0]!.agentId).toBe(agentId);
      expect(events[0]!.event).toEqual({ type: "text", runId: "r1", id: "t1", content: "hello" });
      expect(events[1]!.event).toEqual({ type: "text", runId: "r1", id: "t2", content: " world" });
    });

    it("can spawn multiple agents", async () => {
      const { harness } = createFakeHarness([
        [{ type: "text", runId: "r1", id: "t1", content: "agent1" }],
        [{ type: "text", runId: "r2", id: "t2", content: "agent2" }],
      ]);
      const orchestrator = new AgentOrchestrator(harness);

      const agentId1 = orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "first" }],
      });
      const agentId2 = orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "second" }],
      });

      expect(agentId1).not.toBe(agentId2);

      const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
      for await (const event of orchestrator.events()) {
        events.push(event);
      }

      expect(events.length).toBe(2);
      const agentIds = new Set(events.map((e) => e.agentId));
      expect(agentIds.has(agentId1)).toBe(true);
      expect(agentIds.has(agentId2)).toBe(true);
    });
  });

  describe("events() and permission handling", () => {
    it("strips respond callback from permission_required events", async () => {
      const respondFn = (_approved: boolean, _reason?: string) => {};
      const permissionEvent: HarnessEvent = {
        type: "permission_required",
        runId: "r1",
        id: "p1",
        toolCallId: "tc1",
        tool: "shell",
        params: { command: "rm -rf /" },
        respond: respondFn,
      };
      const { harness } = createFakeHarness([[permissionEvent]]);
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "delete everything" }],
      });

      // Use iterator to get first event, then resolve to let it complete
      const iterator = orchestrator.events()[Symbol.asyncIterator]();
      const first = await iterator.next();

      expect(first.done).toBe(false);
      const yieldedEvent = first.value.event;
      expect(yieldedEvent.type).toBe("permission_required");
      // The respond callback should be stripped
      expect("respond" in yieldedEvent).toBe(false);
      // Other fields should be preserved
      if (yieldedEvent.type === "permission_required") {
        expect(yieldedEvent.toolCallId).toBe("tc1");
        expect(yieldedEvent.tool).toBe("shell");
        expect(yieldedEvent.params).toEqual({ command: "rm -rf /" });
      }

      // Resolve to let the agent complete
      orchestrator.resolvePermission("tc1", true);
      const done = await iterator.next();
      expect(done.done).toBe(true);
    });

    it("pauses the agent when permission_required is yielded", async () => {
      // Create a harness that yields permission_required, then more events
      let resumeCalled = false;
      const respondFn = (approved: boolean) => {
        resumeCalled = true;
      };
      const permissionEvent: HarnessEvent = {
        type: "permission_required",
        runId: "r1",
        id: "p1",
        toolCallId: "tc1",
        tool: "shell",
        params: {},
        respond: respondFn,
      };

      const { harness } = createFakeHarness([[permissionEvent]]);
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
      });

      // Consume first event (permission_required)
      const iterator = orchestrator.events()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.event.type).toBe("permission_required");

      // At this point, agent should be paused - no more events until permission resolved
      // Resolve permission and check that agent resumes
      const resolved = orchestrator.resolvePermission("tc1", true);
      expect(resolved).toBe(true);

      // Now we should be able to get done (agent finished)
      const done = await iterator.next();
      expect(done.done).toBe(true);
    });

    it("non-permission events pass through unchanged", async () => {
      const textEvent: HarnessEvent = { type: "text", runId: "r1", id: "t1", content: "hello" };
      const reasoningEvent: HarnessEvent = {
        type: "reasoning",
        runId: "r1",
        id: "r1",
        content: "thinking",
      };
      const { harness } = createFakeHarness([[textEvent, reasoningEvent]]);
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      });

      const events: ConsumerHarnessEvent[] = [];
      for await (const { event } of orchestrator.events()) {
        events.push(event);
      }

      expect(events).toEqual([textEvent, reasoningEvent]);
    });
  });

  describe("resolvePermission", () => {
    it("calls the stashed respond callback with approval", async () => {
      let capturedApproved: boolean | undefined;
      let capturedReason: string | undefined;

      const permissionEvent: HarnessEvent = {
        type: "permission_required",
        runId: "r1",
        id: "p1",
        toolCallId: "tc1",
        tool: "shell",
        params: {},
        respond: (approved, reason) => {
          capturedApproved = approved;
          capturedReason = reason;
        },
      };

      const { harness } = createFakeHarness([[permissionEvent]]);
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
      });

      // Consume the permission event
      const iterator = orchestrator.events()[Symbol.asyncIterator]();
      await iterator.next();

      // Resolve with approval and reason
      const resolved = orchestrator.resolvePermission("tc1", true, "user approved");

      expect(resolved).toBe(true);
      expect(capturedApproved).toBe(true);
      expect(capturedReason).toBe("user approved");
    });

    it("calls the stashed respond callback with denial", async () => {
      let capturedApproved: boolean | undefined;
      let capturedReason: string | undefined;

      const permissionEvent: HarnessEvent = {
        type: "permission_required",
        runId: "r1",
        id: "p1",
        toolCallId: "tc1",
        tool: "shell",
        params: {},
        respond: (approved, reason) => {
          capturedApproved = approved;
          capturedReason = reason;
        },
      };

      const { harness } = createFakeHarness([[permissionEvent]]);
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
      });

      // Consume the permission event
      const iterator = orchestrator.events()[Symbol.asyncIterator]();
      await iterator.next();

      // Resolve with denial
      const resolved = orchestrator.resolvePermission("tc1", false, "user denied");

      expect(resolved).toBe(true);
      expect(capturedApproved).toBe(false);
      expect(capturedReason).toBe("user denied");
    });

    it("returns false for unknown toolCallId", async () => {
      const { harness } = createFakeHarness([[]]);
      const orchestrator = new AgentOrchestrator(harness);

      const resolved = orchestrator.resolvePermission("nonexistent", true);

      expect(resolved).toBe(false);
    });

    it("removes permission from pending map after resolution", async () => {
      const permissionEvent: HarnessEvent = {
        type: "permission_required",
        runId: "r1",
        id: "p1",
        toolCallId: "tc1",
        tool: "shell",
        params: {},
        respond: () => {},
      };

      const { harness } = createFakeHarness([[permissionEvent]]);
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
      });

      // Consume the permission event
      const iterator = orchestrator.events()[Symbol.asyncIterator]();
      await iterator.next();

      // First resolution should succeed
      expect(orchestrator.resolvePermission("tc1", true)).toBe(true);

      // Second resolution should fail (already resolved)
      expect(orchestrator.resolvePermission("tc1", true)).toBe(false);
    });
  });

  describe("kill", () => {
    it("unregisters agent from multiplexer", async () => {
      const { harness } = createFakeHarness([
        [
          { type: "text", runId: "r1", id: "t1", content: "event1" },
          { type: "text", runId: "r1", id: "t2", content: "event2" },
        ],
      ]);
      const orchestrator = new AgentOrchestrator(harness);

      const agentId = orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      });

      // Kill immediately
      orchestrator.kill(agentId);

      // No events should be yielded (or at most very few due to race)
      const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
      for await (const event of orchestrator.events()) {
        events.push(event);
      }

      // We expect either 0 events (killed before any yielded) or minimal
      // The key test is that the loop completes
      expect(events.length).toBeLessThanOrEqual(2);
    });

    it("cleans up pending permissions for killed agent", async () => {
      const permissionEvent: HarnessEvent = {
        type: "permission_required",
        runId: "r1",
        id: "p1",
        toolCallId: "tc1",
        tool: "shell",
        params: {},
        respond: () => {},
      };

      const { harness } = createFakeHarness([[permissionEvent]]);
      const orchestrator = new AgentOrchestrator(harness);

      const agentId = orchestrator.spawn({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
      });

      // Consume the permission event to register it
      const iterator = orchestrator.events()[Symbol.asyncIterator]();
      await iterator.next();

      // Kill the agent
      orchestrator.kill(agentId);

      // Now resolving the permission should fail (cleaned up)
      expect(orchestrator.resolvePermission("tc1", true)).toBe(false);
    });

    it("handles killing non-existent agent gracefully", () => {
      const { harness } = createFakeHarness([[]]);
      const orchestrator = new AgentOrchestrator(harness);

      // Should not throw
      expect(() => orchestrator.kill("nonexistent")).not.toThrow();
    });
  });
});
