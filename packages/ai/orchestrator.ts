import { v7 } from "uuid";
import type { HarnessEvent, GeneratorInvokeParams, GeneratorHarnessModule } from "./types";
import { createGeneratorHarness } from "./harness/providers/openrouter";
import { createAgentHarness } from "./harness/agent";
import { AgentMultiplexer, type MultiplexedEvent } from "./multiplexer";

/**
 * A pending relay request, stashed until resolved.
 */
export interface PendingRelay {
  agentId: string;
  respond: (response: any) => void;
}

/**
 * HarnessEvent without the respond callback (for consumers).
 * Relay events have respond stripped - use resolveRelay() instead.
 */
export type ConsumerHarnessEvent =
  | Exclude<HarnessEvent, { type: "relay" }>
  | {
      type: "relay";
      kind: "permission";
      runId: string;
      id: string;
      parentId?: string;
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    };

/**
 * Orchestrates multiple AI agents, managing their lifecycle and relay flow.
 *
 * The orchestrator:
 * 1. Creates agents via the generator harness
 * 2. Registers them with a multiplexer for concurrent event streaming
 * 3. Manages relays: stashes respond callbacks, strips them from events
 * 4. Allows consumers to resolve relays via resolveRelay()
 *
 * @example
 * ```ts
 * const orchestrator = new AgentOrchestrator();
 *
 * const agentId = orchestrator.spawn({
 *   model: "openai/gpt-4",
 *   messages: [{ role: "user", content: "Hello" }],
 *   tools: [myTool],
 * });
 *
 * for await (const { agentId, event } of orchestrator.events()) {
 *   if (event.type === "relay") {
 *     // Handle relay request
 *     orchestrator.resolveRelay(event.id, { approved: true });
 *   } else {
 *     console.log(agentId, event);
 *   }
 * }
 * ```
 */
export class AgentOrchestrator {
  private harness: GeneratorHarnessModule;
  private mux = new AgentMultiplexer<HarnessEvent>();
  private pendingRelays = new Map<string, PendingRelay>();

  /**
   * Create a new orchestrator.
   * @param harness Optional harness module (defaults to agent harness wrapping OpenRouter)
   */
  constructor(harness?: GeneratorHarnessModule) {
    this.harness = harness ?? createAgentHarness({ harness: createGeneratorHarness() });
  }

  /**
   * Spawn a new agent. Returns the agent ID.
   *
   * The agent is immediately registered with the multiplexer and starts
   * producing events that can be consumed via events().
   */
  spawn(params: GeneratorInvokeParams): string {
    const agentId = v7();
    const stream = this.harness.invoke(params);
    this.mux.register(agentId, stream);
    return agentId;
  }

  /**
   * Kill an agent by ID.
   *
   * Unregisters the agent from the multiplexer and cleans up any
   * pending relay requests for this agent.
   */
  kill(agentId: string): void {
    this.mux.unregister(agentId);
    // Clean up any pending relays for this agent
    for (const [relayId, pending] of this.pendingRelays) {
      if (pending.agentId === agentId) {
        this.pendingRelays.delete(relayId);
      }
    }
  }

  /**
   * Resolve a pending relay request.
   *
   * @param relayId The ID of the relay awaiting resolution
   * @param response The response to send back to the relay
   * @returns true if the relay was found and resolved, false otherwise
   */
  resolveRelay(relayId: string, response: unknown): boolean {
    const pending = this.pendingRelays.get(relayId);
    if (!pending) return false;

    pending.respond(response);
    this.mux.resume(pending.agentId);
    this.pendingRelays.delete(relayId);
    return true;
  }

  /**
   * Stream all events from all agents.
   *
   * Relay events have their `respond` callback stripped - use
   * `resolveRelay()` to respond to relay requests.
   *
   * When a relay event is yielded:
   * 1. The agent is paused (won't produce more events)
   * 2. The respond callback is stashed internally
   * 3. The event is yielded without the respond callback
   * 4. Call resolveRelay() to resume the agent
   */
  async *events(): AsyncIterable<MultiplexedEvent<ConsumerHarnessEvent>> {
    for await (const { agentId, event } of this.mux.events()) {
      if (event.type === "relay") {
        // Pause this agent until relay resolved
        this.mux.pause(agentId);

        // Stash the responder
        this.pendingRelays.set(event.id, {
          agentId,
          respond: event.respond,
        });

        // Yield event without the respond callback
        const { respond, ...forConsumer } = event;
        yield { agentId, event: forConsumer as ConsumerHarnessEvent };
      } else {
        yield { agentId, event };
      }
    }
  }
}
