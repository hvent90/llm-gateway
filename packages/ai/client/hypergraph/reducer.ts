import type { ConversationGraph, NodeId, EdgeId, UserEvent, ChunkEvent } from "./types";
import { addNodeMut, addEdgeMut, extendEdgeMut } from "./primitives";
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

  const runId = getRunId(event);
  const parentId = getParentId(event);

  // Capture pre-mutation values needed later
  const isFirstEventForRun = !state.lastChunkByRunId.has(runId);
  const currentBlockKey = state.currentBlockIdByRunId.get(runId);

  // Mutate graph in place — all callers immediately reassign: [g, s] = reduceEvent(...)
  const g = graph;

  state.chunkCounter = state.chunkCounter + 1;
  const chunkId = `chunk:${state.chunkCounter}`;

  // 1. Create chunk node
  addNodeMut(g, { id: chunkId, kind: "chunk", content: event as ChunkEvent });

  // 2. Chunk-level sequence edge
  const prevChunk = state.lastChunkByRunId.get(runId);
  if (prevChunk) {
    addEdgeMut(g, {
      id: `seq:chunk:${prevChunk}:${chunkId}`,
      type: "sequence",
      roles: { predecessor: [prevChunk], successor: [chunkId] },
      properties: {},
    });
  }
  state.lastChunkByRunId.set(runId, chunkId);

  // 3. Block logic — same blockKey = extend, new blockKey = new block
  if (currentBlockKey === blockKey) {
    const blockEdgeId = state.currentBlockEdgeByRunId.get(runId)!;
    extendEdgeMut(g, blockEdgeId, "part", [chunkId]);
  } else {
    const blockNodeId = `block:${blockKey}`;
    addNodeMut(g, { id: blockNodeId, kind: "block" });

    const blockEdgeId = `be:${blockKey}`;
    addEdgeMut(g, {
      id: blockEdgeId,
      type: "block",
      roles: { part: [chunkId], whole: [blockNodeId] },
      properties: {},
    });

    const prevBlock = state.lastBlockByRunId.get(runId);
    if (prevBlock) {
      addEdgeMut(g, {
        id: `seq:block:${prevBlock}:${blockNodeId}`,
        type: "sequence",
        roles: { predecessor: [prevBlock], successor: [blockNodeId] },
        properties: {},
      });
    }

    const childRuns = state.childRunsByParent.get(runId);
    if (childRuns) {
      for (const childRunId of childRuns) {
        const childLastBlock = state.lastBlockByRunId.get(childRunId);
        if (childLastBlock && childLastBlock !== blockNodeId && childLastBlock !== prevBlock) {
          addEdgeMut(g, {
            id: `seq:cross:${childLastBlock}:${blockNodeId}`,
            type: "sequence",
            roles: { predecessor: [childLastBlock], successor: [blockNodeId] },
            properties: {},
          });
        }
      }
    }

    state.lastBlockByRunId.set(runId, blockNodeId);
    state.currentBlockIdByRunId.set(runId, blockKey);
    state.currentBlockEdgeByRunId.set(runId, blockEdgeId);

    if ("id" in event) {
      state.eventIdToBlockNodeId.set(event.id as string, blockNodeId);
      state.eventIdToRunId.set(event.id as string, runId);
    }
    if (event.type === "harness_start") {
      state.eventIdToBlockNodeId.set(runId, blockNodeId);
      state.eventIdToRunId.set(runId, runId);
    }
  }

  // 4. Spawn edge + cross-run sequence edge for parentId
  if (parentId && isFirstEventForRun) {
    const parentBlockNodeId = state.eventIdToBlockNodeId.get(parentId) ?? `block:${parentId}`;
    if (g.nodes.has(parentBlockNodeId)) {
      addEdgeMut(g, {
        id: `spawn:${parentId}:${chunkId}`,
        type: "spawn",
        roles: { trigger: [parentBlockNodeId], invocation: [chunkId] },
        properties: {},
      });

      const parentRunId = state.eventIdToRunId.get(parentId) ?? parentId;
      const children = state.childRunsByParent.get(parentRunId) ?? new Set();
      children.add(runId);
      state.childRunsByParent.set(parentRunId, children);

      const parentLastBlock = state.lastBlockByRunId.get(parentRunId);
      const thisBlock = `block:${blockKey}`;
      if (parentLastBlock && parentLastBlock !== thisBlock) {
        addEdgeMut(g, {
          id: `seq:cross:${parentLastBlock}:${thisBlock}`,
          type: "sequence",
          roles: { predecessor: [parentLastBlock], successor: [thisBlock] },
          properties: {},
        });
      }
    }
  }

  // 5. Message boundary detection
  const currentBlockKey2 = state.currentBlockIdByRunId.get(runId);
  const currentBlockNodeId = currentBlockKey2 ? `block:${currentBlockKey2}` : null;

  if (event.type === "text" || event.type === "reasoning") {
    const hadToolResult =
      state.hadToolResultSinceLastText.get(runId) ||
      (parentId && state.hadToolResultSinceLastText.get(parentId));
    if (hadToolResult) {
      const flushRunId =
        parentId && state.hadToolResultSinceLastText.get(parentId) ? parentId : runId;
      const pending = [...(state.pendingBlocksByRunId.get(flushRunId) ?? [])];
      const childRuns = state.childRunsByParent.get(flushRunId);
      if (childRuns) {
        for (const childRunId of childRuns) {
          const childPending = state.pendingBlocksByRunId.get(childRunId);
          if (childPending && childPending.length > 0) {
            pending.push(...childPending);
            state.pendingBlocksByRunId.set(childRunId, []);
          }
        }
      }
      if (pending.length > 0) {
        flushMessageMut(g, state, pending);
      }
      state.pendingBlocksByRunId.set(flushRunId, []);
      state.hadToolResultSinceLastText.set(runId, false);
      if (parentId) state.hadToolResultSinceLastText.set(parentId, false);
    }
  }

  if (event.type === "tool_result" || event.type === "repl_output") {
    state.hadToolResultSinceLastText.set(runId, true);
  }

  if (currentBlockKey !== blockKey && currentBlockNodeId) {
    const pending = state.pendingBlocksByRunId.get(runId) ?? [];
    pending.push(currentBlockNodeId);
    state.pendingBlocksByRunId.set(runId, pending);
  }

  if (event.type === "user" && currentBlockNodeId) {
    flushMessageMut(g, state, [currentBlockNodeId]);
    state.pendingBlocksByRunId.set(runId, []);
  }

  if (event.type === "harness_end") {
    const pending = [...(state.pendingBlocksByRunId.get(runId) ?? [])];
    const childRuns = state.childRunsByParent.get(runId);
    if (childRuns) {
      for (const childRunId of childRuns) {
        const childPending = state.pendingBlocksByRunId.get(childRunId);
        if (childPending && childPending.length > 0) {
          pending.push(...childPending);
          state.pendingBlocksByRunId.set(childRunId, []);
        }
      }
    }
    if (pending.length > 0) {
      flushMessageMut(g, state, pending);
      state.pendingBlocksByRunId.set(runId, []);
    }
    state.hadToolResultSinceLastText.delete(runId);
  }

  return [g, state];
}

function flushMessageMut(graph: ConversationGraph, state: ReducerState, blockIds: NodeId[]): void {
  state.messageCounter += 1;
  const messageId = `msg:${state.messageCounter}`;

  addNodeMut(graph, { id: messageId, kind: "message" });
  addEdgeMut(graph, {
    id: `me:${messageId}`,
    type: "message",
    roles: { part: [...blockIds], whole: [messageId] },
    properties: {},
  });

  if (state.lastMessageId) {
    addEdgeMut(graph, {
      id: `seq:msg:${state.lastMessageId}:${messageId}`,
      type: "sequence",
      roles: { predecessor: [state.lastMessageId], successor: [messageId] },
      properties: {},
    });
  }

  state.lastMessageId = messageId;
}
