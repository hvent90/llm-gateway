/**
 * A multiplexed event from an agent.
 */
export type MultiplexedEvent<T> = {
  agentId: string;
  event: T;
};

/**
 * Internal agent state for multiplexing.
 */
type AgentState<T> = {
  iterator: AsyncIterator<T>;
  paused: boolean;
  pending: Promise<{ agentId: string; result: IteratorResult<T> }> | null;
};

/**
 * Multiplexes multiple async iterables into a single stream.
 *
 * Allows multiple agents to run concurrently, yielding events from
 * whichever agent is ready first. Agents can be paused and resumed
 * independently - pausing one agent does not block others.
 *
 * @example
 * ```ts
 * const multiplexer = new AgentMultiplexer<string>();
 *
 * multiplexer.register("agent1", asyncIterable1);
 * multiplexer.register("agent2", asyncIterable2);
 *
 * for await (const { agentId, event } of multiplexer.events()) {
 *   console.log(`${agentId}: ${event}`);
 * }
 * ```
 */
export class AgentMultiplexer<T> {
  private agents = new Map<string, AgentState<T>>();
  private wakeup: (() => void) | null = null;

  /**
   * Register an agent with its async iterable stream.
   *
   * The agent will immediately start being polled for events.
   * Events are yielded through the events() async iterator.
   */
  register(agentId: string, iterable: AsyncIterable<T>): void {
    const iterator = iterable[Symbol.asyncIterator]();
    this.agents.set(agentId, { iterator, paused: false, pending: null });
    this.pull(agentId);
    this.wake();
  }

  /**
   * Unregister an agent and clean up its resources.
   *
   * Calls iterator.return() to allow the iterator to clean up.
   */
  unregister(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.iterator.return?.();
      this.agents.delete(agentId);
    }
  }

  /**
   * Pause an agent. Its pending promise is kept but not yielded.
   *
   * Pausing an agent does NOT block other agents from producing events.
   */
  pause(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.paused = true;
  }

  /**
   * Resume a paused agent.
   *
   * If the agent has a pending value, it will be yielded.
   * If not, starts polling for the next value.
   * Wakes up the consumer to process the resumed agent.
   */
  resume(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.paused = false;
      if (!agent.pending) this.pull(agentId);
      this.wake();
    }
  }

  /**
   * Wake the events() loop so it re-collects the racing set.
   */
  private wake(): void {
    if (this.wakeup) {
      this.wakeup();
      this.wakeup = null;
    }
  }

  /**
   * Start pulling the next value from an agent's iterator.
   *
   * Only pulls if the agent exists, is not paused, and has no pending promise.
   */
  private pull(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.paused || agent.pending) return;

    agent.pending = agent.iterator.next().then((result) => ({ agentId, result }));
  }

  /**
   * Check if there are any active agents.
   *
   * An agent is active if it's not paused, or if it's paused but has a pending promise.
   * When all agents are paused with no pending promises, we still return true if there
   * are agents, because they may be resumed later via signal.push().
   */
  private hasActiveAgents(): boolean {
    // If no agents registered, we're done
    if (this.agents.size === 0) return false;
    // Otherwise, keep running - agents may be resumed or have pending work
    return true;
  }

  /**
   * Async iterator that yields events from all registered agents.
   *
   * Uses Promise.race() to yield from whichever agent is ready first.
   * When an agent is paused, its pending promise is excluded from racing.
   * When all agents are done, the iterator completes.
   */
  async *events(): AsyncIterable<MultiplexedEvent<T>> {
    while (this.hasActiveAgents()) {
      // Collect non-paused pending promises
      const racing: Array<Promise<{ agentId: string; result: IteratorResult<T> }>> = [];

      for (const [agentId, agent] of this.agents) {
        if (agent.pending && !agent.paused) {
          racing.push(agent.pending);
        }
      }

      if (racing.length === 0) {
        // All paused or no pending — wait for a wake signal
        await new Promise<void>((r) => {
          this.wakeup = r;
        });
        continue;
      }

      // Race all active agents, plus a wakeup promise so that register()/resume()
      // can interrupt the race when new agents need to be included
      const wakeupPromise = new Promise<null>((r) => {
        this.wakeup = () => r(null);
      });
      const winner = await Promise.race([...racing, wakeupPromise]);

      if (!winner) continue; // Wakeup fired — re-collect racing

      const { agentId, result } = winner;
      const agent = this.agents.get(agentId);

      if (!agent) continue; // Agent was removed while racing

      agent.pending = null;

      if (result.done) {
        this.agents.delete(agentId);
        continue;
      }

      yield { agentId, event: result.value };

      // Re-fetch agent after yield (it may have been unregistered during yield)
      const currentAgent = this.agents.get(agentId);
      if (currentAgent && !currentAgent.paused) this.pull(agentId);
    }
  }
}
