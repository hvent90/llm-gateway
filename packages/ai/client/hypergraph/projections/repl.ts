import type { ConversationGraph, NodeId, ChunkEvent } from "../types";
import { getNode, findEdges } from "../primitives";
import { chunksOf } from "../queries";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReplPhase =
  | "idle"
  | "reasoning"
  | "code"
  | "executing"
  | "done"
  | "error"
  | "permission";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ReplTurn {
  iteration: number;
  phase: ReplPhase;
  reasoning: string | null;
  code: string | null;
  stdout: string;
  stderr: string;
  output: {
    stdout: string;
    error?: string;
    durationMs?: number;
    truncated?: boolean;
    done: boolean;
  } | null;
  errorMessage: string | null;
  childAgents: ReplAgent[];
  usage: TurnUsage | null;
}

export interface ReplAgent {
  runId: string;
  agentId: string;
  parentId?: string;
  status: "running" | "done" | "error" | "max_iterations";
  maxIterations?: number;
  depth: number;
  turns: ReplTurn[];
  finalAnswer: string | null;
  totalUsage: { inputTokens: number; outputTokens: number } | null;
}

export interface ReplData {
  agents: ReplAgent[];
  allAgents: Map<string, ReplAgent>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTurn(iteration: number): ReplTurn {
  return {
    iteration,
    phase: "idle",
    reasoning: null,
    code: null,
    stdout: "",
    stderr: "",
    output: null,
    errorMessage: null,
    childAgents: [],
    usage: null,
  };
}

/**
 * Walk chunks for a run in sequence order, starting from the first chunk.
 */
function collectRunChunks(graph: ConversationGraph, runId: string): ChunkEvent[] {
  const events: ChunkEvent[] = [];
  const visited = new Set<NodeId>();

  // Find the first chunk for this runId (no chunk-level predecessor in the same run)
  let startChunkId: NodeId | null = null;
  for (const [id, node] of graph.nodes) {
    if (node.kind !== "chunk") continue;
    if (node.content.runId !== runId) continue;
    // Check if has a chunk predecessor
    const predEdges = findEdges(graph, { type: "sequence", node: id, role: "successor" });
    const hasChunkPred = predEdges.some((e) =>
      e.roles.predecessor.some((pid) => {
        const pn = getNode(graph, pid);
        return pn?.kind === "chunk" && pn.content.runId === runId;
      }),
    );
    if (!hasChunkPred) {
      startChunkId = id;
      break;
    }
  }

  if (!startChunkId) return events;

  // Walk in sequence order
  let current: NodeId | null = startChunkId;
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const node = getNode(graph, current);
    if (!node || node.kind !== "chunk") break;
    if (node.content.runId === runId) {
      events.push(node.content);
    }
    // Find next chunk in this run's sequence
    const seqEdges = findEdges(graph, { type: "sequence", node: current, role: "predecessor" });
    let next: NodeId | null = null;
    for (const edge of seqEdges) {
      for (const succId of edge.roles.successor) {
        const succNode = getNode(graph, succId);
        if (succNode?.kind === "chunk" && succNode.content.runId === runId) {
          next = succId;
          break;
        }
      }
      if (next) break;
    }
    current = next;
  }

  return events;
}

/**
 * Find all runIds present in the graph.
 */
function collectRunIds(graph: ConversationGraph): Set<string> {
  const runIds = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.kind === "chunk" && node.content.runId) {
      runIds.add(node.content.runId);
    }
  }
  return runIds;
}

/**
 * Find child agent runIds spawned from a block in this agent's run.
 */
function findChildRunIds(graph: ConversationGraph, blockNodeId: NodeId): string[] {
  const spawnEdges = findEdges(graph, { type: "spawn", node: blockNodeId, role: "trigger" });
  const childRunIds: string[] = [];
  for (const edge of spawnEdges) {
    for (const invId of edge.roles.invocation) {
      const node = getNode(graph, invId);
      if (node?.kind === "chunk") {
        childRunIds.push(node.content.runId);
      }
    }
  }
  return childRunIds;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function projectRepl(graph: ConversationGraph): ReplData {
  if (graph.nodes.size === 0) {
    return { agents: [], allAgents: new Map() };
  }

  const runIds = collectRunIds(graph);
  const allAgents = new Map<string, ReplAgent>();

  // First pass: build agent for each runId
  for (const runId of runIds) {
    const events = collectRunChunks(graph, runId);
    if (events.length === 0) continue;

    const agent: ReplAgent = {
      runId,
      agentId: "",
      status: "running",
      depth: 0,
      turns: [],
      finalAnswer: null,
      totalUsage: null,
    };

    let currentTurn: ReplTurn = createTurn(1);
    let turnStarted = false;
    let collectingFinalAnswer = false;

    for (const event of events) {
      switch (event.type) {
        case "harness_start": {
          agent.agentId = event.agentId;
          if (event.parentId) agent.parentId = event.parentId;
          if (event.depth !== undefined) agent.depth = event.depth;
          if (event.maxIterations !== undefined) agent.maxIterations = event.maxIterations;
          break;
        }
        case "harness_end": {
          if (agent.status !== "error") {
            if (event.reason === "max_iterations") {
              agent.status = "max_iterations";
            } else {
              agent.status = "done";
            }
          }
          if (event.totalUsage) agent.totalUsage = event.totalUsage;
          break;
        }
        case "text":
        case "reasoning": {
          if (collectingFinalAnswer) {
            agent.finalAnswer = (agent.finalAnswer ?? "") + event.content;
          } else if (currentTurn.output || currentTurn.errorMessage) {
            // Text after output/error belongs to the next turn — push current and start new
            agent.turns.push(currentTurn);
            currentTurn = createTurn(agent.turns.length + 1);
            currentTurn.reasoning = event.content;
            currentTurn.phase = "reasoning";
          } else {
            if (!currentTurn.reasoning) currentTurn.reasoning = "";
            currentTurn.reasoning += event.content;
            currentTurn.phase = "reasoning";
          }
          break;
        }
        case "repl_input": {
          if (turnStarted && !currentTurn.code) {
            // Turn already started by preceding reasoning — just set code
          } else if (turnStarted) {
            // Push the previous turn and start a new one
            agent.turns.push(currentTurn);
            currentTurn = createTurn(agent.turns.length + 1);
          }
          turnStarted = true;
          collectingFinalAnswer = false;
          currentTurn.code = event.code;
          currentTurn.phase = "code";
          if (event.iteration !== undefined) {
            currentTurn.iteration = event.iteration;
          }
          break;
        }
        case "repl_progress": {
          currentTurn.phase = "executing";
          if (event.stream === "stdout") {
            currentTurn.stdout += event.chunk;
          } else {
            currentTurn.stderr += event.chunk;
          }
          break;
        }
        case "repl_output": {
          currentTurn.output = {
            stdout: event.stdout,
            error: event.error,
            durationMs: event.durationMs,
            truncated: event.truncated,
            done: event.done,
          };
          if (event.error) {
            currentTurn.phase = "error";
          } else {
            currentTurn.phase = "done";
          }
          if (event.done) {
            collectingFinalAnswer = true;
          }
          break;
        }
        case "error": {
          agent.status = "error";
          currentTurn.phase = "error";
          currentTurn.errorMessage = event.message;
          break;
        }
        case "usage": {
          currentTurn.usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
          };
          break;
        }
        case "relay": {
          currentTurn.phase = "permission";
          break;
        }
        default:
          break;
      }
    }

    // Push the last turn if it had any content
    if (turnStarted || currentTurn.reasoning || currentTurn.errorMessage) {
      agent.turns.push(currentTurn);
    }

    // Skip runs that never saw harness_start (e.g. user message runs)
    if (!agent.agentId) continue;

    allAgents.set(runId, agent);
  }

  // Second pass: wire up child agents to parent turns
  for (const [runId, agent] of allAgents) {
    const events = collectRunChunks(graph, runId);
    let turnIndex = -1;
    const attachedChildren = new Set<string>();

    for (const event of events) {
      if (event.type === "repl_input") {
        turnIndex++;
      }
      // Check spawn edges from the block containing this event's chunk
      if ("id" in event) {
        const blockNodeId = `block:${event.id}`;
        if (graph.nodes.has(blockNodeId)) {
          const childRunIds = findChildRunIds(graph, blockNodeId);
          for (const childRunId of childRunIds) {
            if (attachedChildren.has(childRunId)) continue;
            const childAgent = allAgents.get(childRunId);
            if (childAgent) {
              const ti = Math.max(0, turnIndex);
              if (agent.turns[ti]) {
                agent.turns[ti].childAgents.push(childAgent);
                attachedChildren.add(childRunId);
              }
            }
          }
        }
      }
    }
  }

  // Collect root agents (no parentId)
  const agents: ReplAgent[] = [];
  for (const agent of allAgents.values()) {
    if (!agent.parentId) {
      agents.push(agent);
    }
  }

  return { agents, allAgents };
}
