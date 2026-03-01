import type { ConversationGraph, NodeId, EdgeId, UserEvent, ChunkEvent } from "./types";
import { addNode, addEdge, extendEdge } from "./primitives";
import type { ServerEvent } from "../server-event";

export type GraphEvent = ServerEvent | UserEvent;

export interface ReducerState {
  lastChunkByRunId: Map<string, NodeId>;
  lastBlockByRunId: Map<string, NodeId>;
  currentBlockIdByRunId: Map<string, string>;
  currentBlockEdgeByRunId: Map<string, EdgeId>;
  chunkCounter: number;
  // Message boundary state
  pendingBlocksByRunId: Map<string, NodeId[]>;
  lastMessageId: NodeId | null;
  hadToolResultSinceLastText: Map<string, boolean>;
  messageCounter: number;
  // Maps raw event ID → block node ID for spawn edge resolution
  eventIdToBlockNodeId: Map<string, NodeId>;
  // Maps raw event ID → runId that produced it
  eventIdToRunId: Map<string, string>;
  // Parent-child run tracking: parentRunId → Set<childRunId>
  childRunsByParent: Map<string, Set<string>>;
}

export function createReducerState(): ReducerState {
  return {
    lastChunkByRunId: new Map(),
    lastBlockByRunId: new Map(),
    currentBlockIdByRunId: new Map(),
    currentBlockEdgeByRunId: new Map(),
    chunkCounter: 0,
    pendingBlocksByRunId: new Map(),
    lastMessageId: null,
    hadToolResultSinceLastText: new Map(),
    messageCounter: 0,
    eventIdToBlockNodeId: new Map(),
    eventIdToRunId: new Map(),
    childRunsByParent: new Map(),
  };
}

function deriveBlockKey(event: GraphEvent): string | null {
  switch (event.type) {
    case "connected":
      return null;
    case "text":
    case "reasoning":
      return `${event.runId}:${event.id}`;
    case "tool_call":
    case "relay":
    case "tool_progress":
    case "repl_input":
      return event.id;
    case "tool_result":
      return `${event.id}:result`;
    case "repl_progress":
      return `${event.id}:progress`;
    case "repl_output":
      return `${event.id}:output`;
    case "harness_start":
      return `${event.runId}:harness_start`;
    case "harness_end":
      return `${event.runId}:harness_end`;
    case "error":
      return `${event.runId}:error`;
    case "usage":
      return `${event.runId}:usage`;
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

export function reduceEvent(
  graph: ConversationGraph,
  state: ReducerState,
  event: GraphEvent,
): [ConversationGraph, ReducerState] {
  const blockKey = deriveBlockKey(event);
  if (blockKey === null) return [graph, state];
  const newState: ReducerState = {
    lastChunkByRunId: new Map(state.lastChunkByRunId),
    lastBlockByRunId: new Map(state.lastBlockByRunId),
    currentBlockIdByRunId: new Map(state.currentBlockIdByRunId),
    currentBlockEdgeByRunId: new Map(state.currentBlockEdgeByRunId),
    chunkCounter: state.chunkCounter + 1,
    pendingBlocksByRunId: new Map([...state.pendingBlocksByRunId].map(([k, v]) => [k, [...v]])),
    lastMessageId: state.lastMessageId,
    hadToolResultSinceLastText: new Map(state.hadToolResultSinceLastText),
    messageCounter: state.messageCounter,
    eventIdToBlockNodeId: new Map(state.eventIdToBlockNodeId),
    eventIdToRunId: new Map(state.eventIdToRunId),
    childRunsByParent: new Map([...state.childRunsByParent].map(([k, v]) => [k, new Set(v)])),
  };

  const runId = getRunId(event);
  const parentId = getParentId(event);
  const chunkId = `chunk:${newState.chunkCounter}`;
  let g = graph;

  // 1. Create chunk node (connected events are already filtered by deriveBlockKey)
  g = addNode(g, { id: chunkId, kind: "chunk", content: event as ChunkEvent });

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

    // Sequence after child runs: when a parent run creates a new block,
    // it must come after all child run activity up to this point.
    const childRuns = state.childRunsByParent.get(runId);
    if (childRuns) {
      for (const childRunId of childRuns) {
        const childLastBlock = state.lastBlockByRunId.get(childRunId);
        if (childLastBlock && childLastBlock !== blockNodeId && childLastBlock !== prevBlock) {
          g = addEdge(g, {
            id: `seq:cross:${childLastBlock}:${blockNodeId}`,
            type: "sequence",
            roles: { predecessor: [childLastBlock], successor: [blockNodeId] },
            properties: {},
          });
        }
      }
    }

    newState.lastBlockByRunId.set(runId, blockNodeId);
    newState.currentBlockIdByRunId.set(runId, blockKey);
    newState.currentBlockEdgeByRunId.set(runId, blockEdgeId);

    // Track raw event ID → block node ID and runId for spawn resolution
    if ("id" in event) {
      newState.eventIdToBlockNodeId.set(event.id as string, blockNodeId);
      newState.eventIdToRunId.set(event.id as string, runId);
    }
    // Register runId → harness_start block so child runs can resolve their parentId
    if (event.type === "harness_start") {
      newState.eventIdToBlockNodeId.set(runId, blockNodeId);
      newState.eventIdToRunId.set(runId, runId);
    }
  }

  // 4. Spawn edge + cross-run sequence edge for parentId
  if (parentId && !state.lastChunkByRunId.has(runId)) {
    const parentBlockNodeId = newState.eventIdToBlockNodeId.get(parentId) ?? `block:${parentId}`;
    if (g.nodes.has(parentBlockNodeId)) {
      g = addEdge(g, {
        id: `spawn:${parentId}:${chunkId}`,
        type: "spawn",
        roles: { trigger: [parentBlockNodeId], invocation: [chunkId] },
        properties: {},
      });

      // Register child run for message grouping — key by parent's runId
      const parentRunId = newState.eventIdToRunId.get(parentId) ?? parentId;
      const children = newState.childRunsByParent.get(parentRunId) ?? new Set();
      children.add(runId);
      newState.childRunsByParent.set(parentRunId, children);

      // Thread child into parent's timeline: sequence edge from the parent
      // run's current last block to the child's first block. This preserves
      // temporal ordering across runs without lying about attribution.
      const parentLastBlock = state.lastBlockByRunId.get(parentRunId);
      const thisBlock = `block:${blockKey}`;
      if (parentLastBlock && parentLastBlock !== thisBlock) {
        g = addEdge(g, {
          id: `seq:cross:${parentLastBlock}:${thisBlock}`,
          type: "sequence",
          roles: { predecessor: [parentLastBlock], successor: [thisBlock] },
          properties: {},
        });
      }
    }
  }

  // 5. Message boundary detection
  // Track the current block node id for pending blocks
  const currentBlockKey2 = newState.currentBlockIdByRunId.get(runId);
  const currentBlockNodeId = currentBlockKey2 ? `block:${currentBlockKey2}` : null;

  // Check for text-after-tool-result boundary: flush pending blocks as a message
  // before adding the new text block. Check both this run and parent run, since
  // tool_result is on the agent's runId but text arrives on the provider's runId.
  if (event.type === "text" || event.type === "reasoning") {
    const hadToolResult =
      state.hadToolResultSinceLastText.get(runId) ||
      (parentId && state.hadToolResultSinceLastText.get(parentId));
    if (hadToolResult) {
      // Flush the parent's pending blocks (which include child run blocks)
      const flushRunId =
        parentId && state.hadToolResultSinceLastText.get(parentId) ? parentId : runId;
      const pending = [...(newState.pendingBlocksByRunId.get(flushRunId) ?? [])];
      // Also gather child run blocks
      const childRuns = newState.childRunsByParent.get(flushRunId);
      if (childRuns) {
        for (const childRunId of childRuns) {
          const childPending = newState.pendingBlocksByRunId.get(childRunId);
          if (childPending && childPending.length > 0) {
            pending.push(...childPending);
            newState.pendingBlocksByRunId.set(childRunId, []);
          }
        }
      }
      if (pending.length > 0) {
        const result = flushMessage(g, newState, flushRunId, pending);
        g = result.graph;
        newState.lastMessageId = result.messageId;
        newState.messageCounter = result.messageCounter;
        newState.pendingBlocksByRunId.set(flushRunId, []);
      }
      newState.hadToolResultSinceLastText.set(runId, false);
      if (parentId) newState.hadToolResultSinceLastText.set(parentId, false);
    }
  }

  // Track tool_result / repl_output for text-after-tool-result detection
  if (event.type === "tool_result" || event.type === "repl_output") {
    newState.hadToolResultSinceLastText.set(runId, true);
  }

  // Add current block to pending (only if it's a new block, not extending)
  if (currentBlockKey !== blockKey && currentBlockNodeId) {
    const pending = newState.pendingBlocksByRunId.get(runId) ?? [];
    pending.push(currentBlockNodeId);
    newState.pendingBlocksByRunId.set(runId, pending);
  }

  // User events create their own message immediately
  if (event.type === "user" && currentBlockNodeId) {
    const pending = [currentBlockNodeId];
    const result = flushMessage(g, newState, runId, pending);
    g = result.graph;
    newState.lastMessageId = result.messageId;
    newState.messageCounter = result.messageCounter;
    newState.pendingBlocksByRunId.set(runId, []);
  }

  // harness_end closes the current message — include blocks from child runs
  if (event.type === "harness_end") {
    const pending = [...(newState.pendingBlocksByRunId.get(runId) ?? [])];
    const childRuns = newState.childRunsByParent.get(runId);
    if (childRuns) {
      for (const childRunId of childRuns) {
        const childPending = newState.pendingBlocksByRunId.get(childRunId);
        if (childPending && childPending.length > 0) {
          pending.push(...childPending);
          newState.pendingBlocksByRunId.set(childRunId, []);
        }
      }
    }
    if (pending.length > 0) {
      const result = flushMessage(g, newState, runId, pending);
      g = result.graph;
      newState.lastMessageId = result.messageId;
      newState.messageCounter = result.messageCounter;
      newState.pendingBlocksByRunId.set(runId, []);
    }
    newState.hadToolResultSinceLastText.delete(runId);
  }

  return [g, newState];
}

function flushMessage(
  graph: ConversationGraph,
  state: ReducerState,
  runId: string,
  blockIds: NodeId[],
): { graph: ConversationGraph; messageId: NodeId; messageCounter: number } {
  const messageCounter = state.messageCounter + 1;
  const messageId = `msg:${messageCounter}`;
  let g = graph;

  g = addNode(g, { id: messageId, kind: "message" });
  g = addEdge(g, {
    id: `me:${messageId}`,
    type: "message",
    roles: { part: [...blockIds], whole: [messageId] },
    properties: {},
  });

  // Message-level sequence edge
  if (state.lastMessageId) {
    g = addEdge(g, {
      id: `seq:msg:${state.lastMessageId}:${messageId}`,
      type: "sequence",
      roles: { predecessor: [state.lastMessageId], successor: [messageId] },
      properties: {},
    });
  }

  return { graph: g, messageId, messageCounter };
}
