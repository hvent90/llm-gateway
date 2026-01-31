import { describe, it, expect, beforeAll } from "bun:test";
import { z } from "zod";
import { AgentOrchestrator, type ConsumerHarnessEvent } from "../orchestrator";
import type { ToolDefinition, ToolPermission } from "../types";
import type { MultiplexedEvent } from "../multiplexer";
import { createAgentHarness } from "../harness/agent";
import { createGeneratorHarness } from "../harness/providers/openrouter";
import { createDeterministicHarness } from "../harness/providers/deterministic";

const TEST_MODEL = "nvidia/nemotron-nano-9b-v2:free";

describe("AgentOrchestrator", () => {
  beforeAll(() => {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY required for integration tests");
    }
  });

  describe("spawn", () => {
    it(
      "creates an agent and returns a UUID",
      async () => {
        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        const agentId = orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Say only the word hello" }],
        });

        // Should be a valid UUID v7 (36 chars with dashes)
        expect(agentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

        // Consume events to let agent complete
        for await (const _ of orchestrator.events()) {
          // drain
        }
      },
      { timeout: 30000 },
    );

    it(
      "registers the agent with the multiplexer and events are yielded",
      async () => {
        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        const agentId = orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Say only the word test" }],
        });

        const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
        for await (const event of orchestrator.events()) {
          events.push(event);
        }

        expect(events.length).toBeGreaterThan(0);
        expect(events[0]!.agentId).toBe(agentId);

        // Should have text events
        const textEvents = events.filter((e) => e.event.type === "text");
        expect(textEvents.length).toBeGreaterThan(0);
      },
      { timeout: 30000 },
    );

    it(
      "can spawn multiple agents",
      async () => {
        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        const agentId1 = orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Say only: first" }],
        });
        const agentId2 = orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Say only: second" }],
        });

        expect(agentId1).not.toBe(agentId2);

        const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
        for await (const event of orchestrator.events()) {
          events.push(event);
        }

        // Should have events from both agents
        const agentIds = new Set(events.map((e) => e.agentId));
        expect(agentIds.has(agentId1)).toBe(true);
        expect(agentIds.has(agentId2)).toBe(true);
      },
      { timeout: 60000 },
    );
  });

  describe("events() and permission handling", () => {
    it(
      "strips respond callback from relay events",
      async () => {
        const greetSchema = z.object({ name: z.string() });
        const greetTool: ToolDefinition<typeof greetSchema, string> = {
          name: "greet",
          description: "Greet someone by name. Always use this tool.",
          schema: greetSchema,
          execute: async ({ name }) => ({
            context: `Greeted ${name}`,
            result: `Hello, ${name}!`,
          }),
        };

        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Use the greet tool to greet Alice." }],
          tools: [greetTool],
          permissions: { allowlist: [] }, // Empty allowlist triggers permission_required
        });

        const iterator = orchestrator.events()[Symbol.asyncIterator]();

        // Find the relay event
        let relayEvent: ConsumerHarnessEvent | undefined;
        while (true) {
          const { done, value } = await iterator.next();
          if (done) break;
          if (value.event.type === "relay") {
            relayEvent = value.event;
            break;
          }
        }

        expect(relayEvent).toBeDefined();
        expect(relayEvent!.type).toBe("relay");
        // The respond callback should be stripped
        expect("respond" in relayEvent!).toBe(false);

        if (relayEvent!.type === "relay") {
          expect(relayEvent!.tool).toBe("greet");
          // Resolve to let agent complete
          orchestrator.resolveRelay(relayEvent!.id, { approved: true });
        }

        // Drain remaining events
        while (!(await iterator.next()).done) {}
      },
      { timeout: 60000 },
    );

    it(
      "pauses the agent when relay is yielded until resolved",
      async () => {
        const echoSchema = z.object({ message: z.string() });
        const echoTool: ToolDefinition<typeof echoSchema, string> = {
          name: "echo",
          description: "Echo back a message. Always use this tool.",
          schema: echoSchema,
          execute: async ({ message }) => ({
            context: `Echoed: ${message}`,
            result: message,
          }),
        };

        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Use the echo tool with message 'test'." }],
          tools: [echoTool],
          permissions: { allowlist: [] },
        });

        const events: ConsumerHarnessEvent[] = [];
        let relayId: string | undefined;

        for await (const { event } of orchestrator.events()) {
          events.push(event);
          if (event.type === "relay") {
            relayId = event.id;
            // Resolve permission to continue
            orchestrator.resolveRelay(relayId, { approved: true });
          }
        }

        // Should have relay event
        expect(events.some((e) => e.type === "relay")).toBe(true);

        // After approval, should have tool_call and tool_result
        expect(events.some((e) => e.type === "tool_call")).toBe(true);
        expect(events.some((e) => e.type === "tool_result")).toBe(true);
      },
      { timeout: 60000 },
    );

    it(
      "non-permission events pass through unchanged",
      async () => {
        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Say hello without using any tools." }],
        });

        const events: ConsumerHarnessEvent[] = [];
        for await (const { event } of orchestrator.events()) {
          events.push(event);
        }

        // Should have text events
        const textEvents = events.filter((e) => e.type === "text");
        expect(textEvents.length).toBeGreaterThan(0);

        // No permission events (no tools)
        expect(events.some((e) => e.type === "relay")).toBe(false);
      },
      { timeout: 30000 },
    );
  });

  describe("resolveRelay", () => {
    it(
      "approving permission allows tool execution",
      async () => {
        const addSchema = z.object({ a: z.number(), b: z.number() });
        const addTool: ToolDefinition<typeof addSchema, number> = {
          name: "add",
          description: "Add two numbers. Always use this tool for math.",
          schema: addSchema,
          execute: async ({ a, b }) => ({
            context: `${a} + ${b} = ${a + b}`,
            result: a + b,
          }),
        };

        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Use the add tool to add 2 and 3." }],
          tools: [addTool],
          permissions: { allowlist: [] },
        });

        const events: ConsumerHarnessEvent[] = [];
        for await (const { event } of orchestrator.events()) {
          events.push(event);
          if (event.type === "relay") {
            orchestrator.resolveRelay(event.id, { approved: true });
          }
        }

        // Should have tool_result with successful execution
        const toolResults = events.filter((e) => e.type === "tool_result");
        expect(toolResults.length).toBeGreaterThan(0);

        const result = toolResults[0]!;
        if (result.type === "tool_result") {
          expect((result.output as { result: number }).result).toBe(5);
        }
      },
      { timeout: 60000 },
    );

    it(
      "denying permission yields denied tool_result",
      async () => {
        const dangerSchema = z.object({ action: z.string() });
        const dangerTool: ToolDefinition<typeof dangerSchema, string> = {
          name: "danger",
          description: "A dangerous action. Always use this tool.",
          schema: dangerSchema,
          execute: async ({ action }) => ({
            context: `Did dangerous thing: ${action}`,
            result: action,
          }),
        };

        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Use the danger tool with action 'delete'." }],
          tools: [dangerTool],
          permissions: { allowlist: [] },
        });

        const events: ConsumerHarnessEvent[] = [];
        for await (const { event } of orchestrator.events()) {
          events.push(event);
          if (event.type === "relay") {
            orchestrator.resolveRelay(event.id, { approved: false, reason: "too dangerous" });
          }
        }

        // Should have tool_result with denied status
        const toolResults = events.filter((e) => e.type === "tool_result");
        expect(toolResults.length).toBeGreaterThan(0);

        const deniedResult = toolResults.find(
          (e) => e.type === "tool_result" && (e.output as { status?: string })?.status === "denied",
        );
        expect(deniedResult).toBeDefined();
      },
      { timeout: 60000 },
    );

    it("returns false for unknown relay id", () => {
      const harness = createAgentHarness({ harness: createGeneratorHarness() });
      const orchestrator = new AgentOrchestrator(harness);

      const resolved = orchestrator.resolveRelay("nonexistent", { approved: true });
      expect(resolved).toBe(false);
    });

    it(
      "removes permission from pending map after resolution",
      async () => {
        const pingSchema = z.object({});
        const pingTool: ToolDefinition<typeof pingSchema, string> = {
          name: "ping",
          description: "Ping. Always use this tool.",
          schema: pingSchema,
          execute: async () => ({
            context: "pong",
            result: "pong",
          }),
        };

        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Use the ping tool." }],
          tools: [pingTool],
          permissions: { allowlist: [] },
        });

        const iterator = orchestrator.events()[Symbol.asyncIterator]();
        let relayId: string | undefined;

        // Find permission event
        while (true) {
          const { done, value } = await iterator.next();
          if (done) break;
          if (value.event.type === "relay") {
            relayId = value.event.id;
            break;
          }
        }

        expect(relayId).toBeDefined();

        // First resolution should succeed
        expect(orchestrator.resolveRelay(relayId!, { approved: true })).toBe(true);

        // Second resolution should fail (already resolved)
        expect(orchestrator.resolveRelay(relayId!, { approved: true })).toBe(false);

        // Drain remaining events
        while (!(await iterator.next()).done) {}
      },
      { timeout: 60000 },
    );
  });

  describe("kill", () => {
    it(
      "unregisters agent from multiplexer",
      async () => {
        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        const agentId = orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Count slowly from 1 to 100." }],
        });

        // Kill immediately
        orchestrator.kill(agentId);

        // Should complete quickly with minimal or no events
        const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
        for await (const event of orchestrator.events()) {
          events.push(event);
        }

        // The key test is that the loop completes (doesn't hang)
        // Events may be 0 or a few depending on race conditions
        expect(events.length).toBeLessThanOrEqual(10);
      },
      { timeout: 30000 },
    );

    it(
      "cleans up pending relays for killed agent",
      async () => {
        const waitSchema = z.object({});
        const waitTool: ToolDefinition<typeof waitSchema, string> = {
          name: "wait",
          description: "Wait. Always use this tool.",
          schema: waitSchema,
          execute: async () => ({
            context: "waited",
            result: "done",
          }),
        };

        const harness = createAgentHarness({ harness: createGeneratorHarness() });
        const orchestrator = new AgentOrchestrator(harness);

        const agentId = orchestrator.spawn({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Use the wait tool." }],
          tools: [waitTool],
          permissions: { allowlist: [] },
        });

        const iterator = orchestrator.events()[Symbol.asyncIterator]();
        let relayId: string | undefined;

        // Find permission event
        while (true) {
          const { done, value } = await iterator.next();
          if (done) break;
          if (value.event.type === "relay") {
            relayId = value.event.id;
            break;
          }
        }

        expect(relayId).toBeDefined();

        // Kill the agent
        orchestrator.kill(agentId);

        // Now resolving the permission should fail (cleaned up)
        expect(orchestrator.resolveRelay(relayId!, { approved: true })).toBe(false);
      },
      { timeout: 60000 },
    );

    it("handles killing non-existent agent gracefully", () => {
      const harness = createAgentHarness({ harness: createGeneratorHarness() });
      const orchestrator = new AgentOrchestrator(harness);

      // Should not throw
      expect(() => orchestrator.kill("nonexistent")).not.toThrow();
    });
  });
});

describe("AgentOrchestrator (deterministic)", () => {
  describe("spawnSubagent", () => {
    it("subagent events stream through multiplexer and spawn resolves with final text", async () => {
      // Deterministic provider serves responses in order:
      // Response 0: parent agent's first call -> emits tool_call for "agent"
      // Response 1: subagent's call -> emits text "Hello from subagent"
      // Response 2: parent agent's second call (after tool result) -> emits final text
      const provider = createDeterministicHarness({
        responses: [
          { events: [{ type: "tool_call", name: "agent", input: { task: "say hello" } }] },
          { events: [{ type: "text", content: "Hello from subagent" }] },
          { events: [{ type: "text", content: "Subagent said hello" }] },
        ],
      });

      const agentTool: ToolDefinition = {
        name: "agent",
        description: "Spawn a subagent",
        schema: z.object({ task: z.string() }),
        execute: async ({ task }, ctx) => {
          const result = await ctx.spawn!(task);
          return { context: result, result };
        },
      };

      const harness = createAgentHarness({ harness: provider });
      const orchestrator = new AgentOrchestrator(harness);

      const agentId = orchestrator.spawn({
        model: "deterministic",
        messages: [{ role: "user", content: "Spawn a subagent to say hello" }],
        tools: [agentTool],
        permissions: { allowlist: [{ tool: "agent" }] },
      });

      const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
      for await (const event of orchestrator.events()) {
        events.push(event);
      }

      // Should have events from both parent and subagent
      const agentIds = new Set(events.map((e) => e.agentId));
      expect(agentIds.size).toBe(2);

      // Subagent should have produced text events
      const subagentId = [...agentIds].find((id) => id !== agentId)!;
      const subagentTextEvents = events.filter(
        (e) => e.agentId === subagentId && e.event.type === "text",
      );
      expect(subagentTextEvents.length).toBeGreaterThan(0);

      // Parent should have final text after subagent completed
      const parentTextEvents = events.filter(
        (e) => e.agentId === agentId && e.event.type === "text",
      );
      expect(parentTextEvents.length).toBeGreaterThan(0);
    });

    it("subagent events have parentId set to tool call ID", async () => {
      const provider = createDeterministicHarness({
        responses: [
          { events: [{ type: "tool_call", name: "agent", input: { task: "say hello" } }] },
          { events: [{ type: "text", content: "Hello from subagent" }] },
          { events: [{ type: "text", content: "Done" }] },
        ],
      });

      const agentTool: ToolDefinition = {
        name: "agent",
        description: "Spawn a subagent",
        schema: z.object({ task: z.string() }),
        execute: async ({ task }, ctx) => {
          const result = await ctx.spawn!(task);
          return { context: result, result };
        },
      };

      const harness = createAgentHarness({ harness: provider });
      const orchestrator = new AgentOrchestrator(harness);

      const agentId = orchestrator.spawn({
        model: "deterministic",
        messages: [{ role: "user", content: "Spawn subagent" }],
        tools: [agentTool],
        permissions: { allowlist: [{ tool: "agent" }] },
      });

      const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
      for await (const event of orchestrator.events()) {
        events.push(event);
      }

      // Find the parent's tool_call event to get the tool call ID
      const parentToolCall = events.find(
        (e) =>
          e.agentId === agentId &&
          e.event.type === "tool_call" &&
          (e.event as any).name === "agent",
      );
      expect(parentToolCall).toBeDefined();
      const toolCallId = (parentToolCall!.event as { id: string }).id;

      // Find the subagent's text events
      const subagentId = [...new Set(events.map((e) => e.agentId))].find((id) => id !== agentId)!;
      const subagentTextEvents = events.filter(
        (e) => e.agentId === subagentId && e.event.type === "text",
      );

      // Subagent events should have parentId = toolCallId
      for (const e of subagentTextEvents) {
        expect((e.event as { parentId?: string }).parentId).toBe(toolCallId);
      }
    });

    it("parallel subagent tool calls stream concurrently (deterministic)", async () => {
      // Provider: parent emits two agent tool calls, then two subagent responses, then parent final
      const provider = createDeterministicHarness({
        responses: [
          {
            events: [
              { type: "tool_call", name: "agent", input: { task: "first" } },
              { type: "tool_call", name: "agent", input: { task: "second" } },
            ],
          },
          { events: [{ type: "text", content: "First result" }] },
          { events: [{ type: "text", content: "Second result" }] },
          { events: [{ type: "text", content: "Both done" }] },
        ],
      });

      const agentTool: ToolDefinition = {
        name: "agent",
        description: "Spawn a subagent",
        schema: z.object({ task: z.string() }),
        execute: async ({ task }, ctx) => {
          const result = await ctx.spawn!(task);
          return { context: result, result };
        },
      };

      const harness = createAgentHarness({ harness: provider });
      const orchestrator = new AgentOrchestrator(harness);

      const parentAgentId = orchestrator.spawn({
        model: "deterministic",
        messages: [{ role: "user", content: "Spawn two subagents" }],
        tools: [agentTool],
        permissions: { allowlist: [{ tool: "agent" }] },
      });

      const events: MultiplexedEvent<ConsumerHarnessEvent>[] = [];
      for await (const event of orchestrator.events()) {
        events.push(event);
      }

      // Should have 3 distinct agent IDs: parent + 2 subagents
      const agentIds = new Set(events.map((e) => e.agentId));
      expect(agentIds.size).toBe(3);

      // Parent should have final text
      const parentTextEvents = events.filter(
        (e) => e.agentId === parentAgentId && e.event.type === "text",
      );
      expect(parentTextEvents.length).toBeGreaterThan(0);
    });
  });

  describe("mutable permissions (always allow)", () => {
    it("resolveRelay with always:true adds derived permission to allowlist", async () => {
      // Response 0: LLM emits tool_call for "greet" -> triggers relay (empty allowlist)
      // After approval: tool executes, loop continues
      // Response 1: Final text (no more tool calls)
      const provider = createDeterministicHarness({
        responses: [
          { events: [{ type: "tool_call", name: "greet", input: { name: "Alice" } }] },
          { events: [{ type: "text", content: "Done" }] },
        ],
      });

      const greetSchema = z.object({ name: z.string() });
      const greetTool: ToolDefinition<typeof greetSchema, string> = {
        name: "greet",
        description: "Greet someone",
        schema: greetSchema,
        execute: async ({ name }) => ({
          context: `Greeted ${name}`,
          result: `Hello, ${name}!`,
        }),
      };

      const permissions = { allowlist: [] as ToolPermission[] };
      const harness = createAgentHarness({ harness: provider });
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "deterministic",
        messages: [{ role: "user", content: "Greet Alice" }],
        tools: [greetTool],
        permissions,
      });

      for await (const { event } of orchestrator.events()) {
        if (event.type === "relay") {
          orchestrator.resolveRelay(event.id, { approved: true, always: true });
        }
      }

      // After always:true resolution, the permissions object should have the derived permission
      expect(permissions.allowlist.length).toBe(1);
      expect(permissions.allowlist[0]!.tool).toBe("greet");
    });

    it("after always:true, subsequent matching tool calls do NOT trigger a relay", async () => {
      // Response 0: LLM calls "greet" with { name: "Alice in wonderland" } -> triggers relay
      // After always:true approval: derives permission { tool: "greet", params: { name: "Alice **" } }
      // Response 1: LLM calls "greet" again with { name: "Alice at home" } -> should match "Alice **"
      // Response 2: Final text
      const provider = createDeterministicHarness({
        responses: [
          {
            events: [{ type: "tool_call", name: "greet", input: { name: "Alice in wonderland" } }],
          },
          { events: [{ type: "tool_call", name: "greet", input: { name: "Alice at home" } }] },
          { events: [{ type: "text", content: "All done" }] },
        ],
      });

      const greetSchema = z.object({ name: z.string() });
      const greetTool: ToolDefinition<typeof greetSchema, string> = {
        name: "greet",
        description: "Greet someone",
        schema: greetSchema,
        execute: async ({ name }) => ({
          context: `Greeted ${name}`,
          result: `Hello, ${name}!`,
        }),
      };

      const permissions = { allowlist: [] as ToolPermission[] };
      const harness = createAgentHarness({ harness: provider });
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "deterministic",
        messages: [{ role: "user", content: "Greet Alice twice" }],
        tools: [greetTool],
        permissions,
      });

      const relayEvents: ConsumerHarnessEvent[] = [];
      const allEvents: ConsumerHarnessEvent[] = [];

      for await (const { event } of orchestrator.events()) {
        allEvents.push(event);
        if (event.type === "relay") {
          relayEvents.push(event);
          orchestrator.resolveRelay(event.id, { approved: true, always: true });
        }
      }

      // Only ONE relay should have fired (for the first greet call)
      // The second greet call should have been auto-approved via the mutated allowlist
      expect(relayEvents.length).toBe(1);

      // Both tool calls should have executed successfully
      const toolResults = allEvents.filter((e) => e.type === "tool_result");
      expect(toolResults.length).toBe(2);
    });

    it("resolveRelay with approved:true but no always does NOT add to allowlist", async () => {
      const provider = createDeterministicHarness({
        responses: [
          { events: [{ type: "tool_call", name: "greet", input: { name: "Bob" } }] },
          { events: [{ type: "text", content: "Done" }] },
        ],
      });

      const greetSchema = z.object({ name: z.string() });
      const greetTool: ToolDefinition<typeof greetSchema, string> = {
        name: "greet",
        description: "Greet someone",
        schema: greetSchema,
        execute: async ({ name }) => ({
          context: `Greeted ${name}`,
          result: `Hello, ${name}!`,
        }),
      };

      const permissions = { allowlist: [] as ToolPermission[] };
      const harness = createAgentHarness({ harness: provider });
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "deterministic",
        messages: [{ role: "user", content: "Greet Bob" }],
        tools: [greetTool],
        permissions,
      });

      for await (const { event } of orchestrator.events()) {
        if (event.type === "relay") {
          // Approve without always
          orchestrator.resolveRelay(event.id, { approved: true });
        }
      }

      // Allowlist should remain empty — no derived permission was added
      expect(permissions.allowlist.length).toBe(0);
    });

    it("resolveRelay with approved:false denies and does NOT add to allowlist", async () => {
      const provider = createDeterministicHarness({
        responses: [
          {
            events: [{ type: "tool_call", name: "danger", input: { action: "delete everything" } }],
          },
          { events: [{ type: "text", content: "Ok, denied" }] },
        ],
      });

      const dangerSchema = z.object({ action: z.string() });
      const dangerTool: ToolDefinition<typeof dangerSchema, string> = {
        name: "danger",
        description: "Dangerous action",
        schema: dangerSchema,
        execute: async ({ action }) => ({
          context: `Did: ${action}`,
          result: action,
        }),
      };

      const permissions = { allowlist: [] as ToolPermission[] };
      const harness = createAgentHarness({ harness: provider });
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "deterministic",
        messages: [{ role: "user", content: "Do danger" }],
        tools: [dangerTool],
        permissions,
      });

      const allEvents: ConsumerHarnessEvent[] = [];
      for await (const { event } of orchestrator.events()) {
        allEvents.push(event);
        if (event.type === "relay") {
          orchestrator.resolveRelay(event.id, { approved: false, reason: "too dangerous" });
        }
      }

      // Allowlist should remain empty
      expect(permissions.allowlist.length).toBe(0);

      // Should have a denied tool_result
      const deniedResult = allEvents.find(
        (e) => e.type === "tool_result" && (e.output as { status?: string })?.status === "denied",
      );
      expect(deniedResult).toBeDefined();
    });

    it("without always:true, second call to same tool still triggers a relay", async () => {
      // Response 0: tool_call greet -> relay (approved, no always)
      // Response 1: tool_call greet again -> should still relay (not auto-approved)
      // Response 2: final text
      const provider = createDeterministicHarness({
        responses: [
          {
            events: [{ type: "tool_call", name: "greet", input: { name: "Alice in wonderland" } }],
          },
          { events: [{ type: "tool_call", name: "greet", input: { name: "Alice at home" } }] },
          { events: [{ type: "text", content: "All done" }] },
        ],
      });

      const greetSchema = z.object({ name: z.string() });
      const greetTool: ToolDefinition<typeof greetSchema, string> = {
        name: "greet",
        description: "Greet someone",
        schema: greetSchema,
        execute: async ({ name }) => ({
          context: `Greeted ${name}`,
          result: `Hello, ${name}!`,
        }),
      };

      const permissions = { allowlist: [] as ToolPermission[] };
      const harness = createAgentHarness({ harness: provider });
      const orchestrator = new AgentOrchestrator(harness);

      orchestrator.spawn({
        model: "deterministic",
        messages: [{ role: "user", content: "Greet Alice twice" }],
        tools: [greetTool],
        permissions,
      });

      const relayEvents: ConsumerHarnessEvent[] = [];
      for await (const { event } of orchestrator.events()) {
        if (event.type === "relay") {
          relayEvents.push(event);
          // Approve without always — each call should still relay
          orchestrator.resolveRelay(event.id, { approved: true });
        }
      }

      // TWO relays: one for each tool call (no auto-approval)
      expect(relayEvents.length).toBe(2);
    });
  });
});
