import type { ConversationGraph, NodeId, EdgeId } from "./types";
import { addNode, addEdge, extendEdge } from "./primitives";
import type { ServerEvent } from "../server-event";
import type { UserEvent } from "../graph";

export type GraphEvent = ServerEvent | UserEvent;

interface ReducerState {
  lastChunkByRunId: Map<string, NodeId>;
  lastBlockByRunId: Map<string, NodeId>;
  currentBlockIdByRunId: Map<string, string>;
  currentBlockEdgeByRunId: Map<string, EdgeId>;
  chunkCounter: number;
}

interface ReducerResult extends ConversationGraph {
  _reducerState: ReducerState;
}

function getState(graph: ConversationGraph): ReducerState {
  if ("_reducerState" in graph) return (graph as ReducerResult)._reducerState;
  return {
    lastChunkByRunId: new Map(),
    lastBlockByRunId: new Map(),
    currentBlockIdByRunId: new Map(),
    currentBlockEdgeByRunId: new Map(),
    chunkCounter: 0,
  };
}

function withState(graph: ConversationGraph, state: ReducerState): ConversationGraph {
  return Object.assign(Object.create(null), graph, { _reducerState: state }) as ConversationGraph;
}

function deriveBlockKey(event: GraphEvent): string | null {
  switch (event.type) {
    case "connected":
      return null;
    case "text":
    case "reasoning":
    case "tool_call":
    case "relay":
    case "tool_progress":
      return event.id;
    case "tool_result":
      return `${event.id}:result`;
    case "harness_start":
      return `${event.runId}:harness_start`;
    case "harness_end":
      return `${event.runId}:harness_end`;
    case "error":
      return `${event.runId}:error`;
    case "usage":
      return null; // skip usage events for now — they don't produce visual blocks
    case "user":
      return `${event.runId}:user`;
    default:
      return null;
  }
}

function getRunId(event: GraphEvent): string {
  if (event.type === "connected") return "";
  return event.runId;
}

function getParentId(event: GraphEvent): string | undefined {
  if ("parentId" in event) return event.parentId as string | undefined;
  return undefined;
}

export function reduceEvent(graph: ConversationGraph, event: GraphEvent): ConversationGraph {
  const blockKey = deriveBlockKey(event);
  if (blockKey === null) return graph;

  const state = getState(graph);
  const newState: ReducerState = {
    lastChunkByRunId: new Map(state.lastChunkByRunId),
    lastBlockByRunId: new Map(state.lastBlockByRunId),
    currentBlockIdByRunId: new Map(state.currentBlockIdByRunId),
    currentBlockEdgeByRunId: new Map(state.currentBlockEdgeByRunId),
    chunkCounter: state.chunkCounter + 1,
  };

  const runId = getRunId(event);
  const parentId = getParentId(event);
  const chunkId = `chunk:${newState.chunkCounter}`;
  let g = graph;

  // 1. Create chunk node
  g = addNode(g, { id: chunkId, kind: "chunk", content: event as any });

  // 2. Chunk-level sequence edge
  const prevChunk = state.lastChunkByRunId.get(runId);
  if (prevChunk) {
    g = addEdge(g, {
      id: `seq:chunk:${prevChunk}:${chunkId}`,
      type: "sequence",
      roles: { predecessor: [prevChunk], successor: [chunkId] },
      properties: {},
    });
  }
  newState.lastChunkByRunId.set(runId, chunkId);

  // 3. Block logic — same blockKey = extend, new blockKey = new block
  const currentBlockKey = state.currentBlockIdByRunId.get(runId);
  if (currentBlockKey === blockKey) {
    // Extend existing block edge
    const blockEdgeId = state.currentBlockEdgeByRunId.get(runId)!;
    g = extendEdge(g, blockEdgeId, "part", [chunkId]);
  } else {
    // New block
    const blockNodeId = `block:${blockKey}`;
    g = addNode(g, { id: blockNodeId, kind: "block" });

    // Block edge
    const blockEdgeId = `be:${blockKey}`;
    g = addEdge(g, {
      id: blockEdgeId,
      type: "block",
      roles: { part: [chunkId], whole: [blockNodeId] },
      properties: {},
    });

    // Block-level sequence edge
    const prevBlock = state.lastBlockByRunId.get(runId);
    if (prevBlock) {
      g = addEdge(g, {
        id: `seq:block:${prevBlock}:${blockNodeId}`,
        type: "sequence",
        roles: { predecessor: [prevBlock], successor: [blockNodeId] },
        properties: {},
      });
    }

    newState.lastBlockByRunId.set(runId, blockNodeId);
    newState.currentBlockIdByRunId.set(runId, blockKey);
    newState.currentBlockEdgeByRunId.set(runId, blockEdgeId);
  }

  // 4. Spawn edge for parentId
  if (parentId && !state.lastChunkByRunId.has(runId)) {
    // First event in this run with a parentId — create spawn edge
    // Find the chunk that corresponds to the parent (tool_call)
    // The parentId points to the block key of the triggering tool_call
    // We need to find a chunk in that block
    const parentBlockNodeId = `block:${parentId}`;
    if (g.nodes.has(parentBlockNodeId)) {
      g = addEdge(g, {
        id: `spawn:${parentId}:${chunkId}`,
        type: "spawn",
        roles: { trigger: [parentBlockNodeId], invocation: [chunkId] },
        properties: {},
      });
    }
  }

  return withState(g, newState);
}
