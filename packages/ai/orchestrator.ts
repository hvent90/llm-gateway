import { v7 } from "uuid";
import type { HarnessEvent, GeneratorInvokeParams, GeneratorHarnessModule } from "./types";
import { createGeneratorHarness } from "./harness/providers/openrouter";
import { createAgentHarness } from "./harness/agent";
import { AgentMultiplexer, type MultiplexedEvent } from "./multiplexer";

/**
 * A pending permission request, stashed until resolved.
 */
export interface PendingPermission {
  agentId: string;
  respond: (approved: boolean, reason?: string) => void;
}

/**
 * HarnessEvent without the respond callback (for consumers).
 * Permission events have respond stripped - use resolvePermission() instead.
 */
export type ConsumerHarnessEvent =
  | Exclude<HarnessEvent, { type: "permission_required" }>
  | {
      type: "permission_required";
      runId: string;
      id: string;
      parentId?: string;
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    };

/**
 * Orchestrates multiple AI agents, managing their lifecycle and permission flow.
 *
 * The orchestrator:
 * 1. Creates agents via the generator harness
 * 2. Registers them with a multiplexer for concurrent event streaming
 * 3. Manages permissions: stashes respond callbacks, strips them from events
 * 4. Allows consumers to resolve permissions via resolvePermission()
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
 *   if (event.type === "permission_required") {
 *     // Handle permission request
 *     orchestrator.resolvePermission(event.toolCallId, true);
 *   } else {
 *     console.log(agentId, event);
 *   }
 * }
 * ```
 */
export class AgentOrchestrator {
  private harness: GeneratorHarnessModule;
  private mux = new AgentMultiplexer<HarnessEvent>();
  private pendingPermissions = new Map<string, PendingPermission>();

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
   * pending permission requests for this agent.
   */
  kill(agentId: string): void {
    this.mux.unregister(agentId);
    // Clean up any pending permissions for this agent
    for (const [toolCallId, pending] of this.pendingPermissions) {
      if (pending.agentId === agentId) {
        this.pendingPermissions.delete(toolCallId);
      }
    }
  }

  /**
   * Resolve a pending permission request.
   *
   * @param toolCallId The ID of the tool call awaiting permission
   * @param approved Whether the permission is granted
   * @param reason Optional reason for the decision
   * @returns true if the permission was found and resolved, false otherwise
   */
  resolvePermission(toolCallId: string, approved: boolean, reason?: string): boolean {
    const pending = this.pendingPermissions.get(toolCallId);
    if (!pending) return false;

    pending.respond(approved, reason);
    this.mux.resume(pending.agentId);
    this.pendingPermissions.delete(toolCallId);
    return true;
  }

  /**
   * Stream all events from all agents.
   *
   * Permission events have their `respond` callback stripped - use
   * `resolvePermission()` to respond to permission requests.
   *
   * When a permission_required event is yielded:
   * 1. The agent is paused (won't produce more events)
   * 2. The respond callback is stashed internally
   * 3. The event is yielded without the respond callback
   * 4. Call resolvePermission() to resume the agent
   */
  async *events(): AsyncIterable<MultiplexedEvent<ConsumerHarnessEvent>> {
    for await (const { agentId, event } of this.mux.events()) {
      if (event.type === "permission_required") {
        // Pause this agent until permission resolved
        this.mux.pause(agentId);

        // Stash the responder
        this.pendingPermissions.set(event.toolCallId, {
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
