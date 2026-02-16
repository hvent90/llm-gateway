import { describe, test, expect } from "bun:test";
import { createGraph, addNode, addEdge, findEdges } from "../primitives";
import type { ConversationGraph, NodeId } from "../types";
import {
  defaultActive,
  fullHistoryActive,
  walk,
  findHead,
  findNextActive,
  findPrevActive,
  descendToFirstActive,
  findAggregate,
  validate,
} from "../walk";

// Helper: build a simple linear message graph
//   msg_1 --seq--> msg_2 --seq--> msg_3
function buildLinearMessages(): ConversationGraph {
  let g = createGraph();
  g = addNode(g, { id: "msg_1", kind: "message" });
  g = addNode(g, { id: "msg_2", kind: "message" });
  g = addNode(g, { id: "msg_3", kind: "message" });
  g = addEdge(g, {
    id: "seq:m1:m2",
    type: "sequence",
    roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
    properties: {},
  });
  g = addEdge(g, {
    id: "seq:m2:m3",
    type: "sequence",
    roles: { predecessor: ["msg_2"], successor: ["msg_3"] },
    properties: {},
  });
  return g;
}

// Helper: build a message graph with a summary
//   msg_1 --seq--> msg_2 --seq--> msg_3 --seq--> msg_4
//            \                           /
//             --seq--> summary_1 --seq--
//   summary edge: { source: [msg_2, msg_3], result: [summary_1] }
function buildSummarizedGraph(): ConversationGraph {
  let g = createGraph();
  g = addNode(g, { id: "msg_1", kind: "message" });
  g = addNode(g, { id: "msg_2", kind: "message" });
  g = addNode(g, { id: "msg_3", kind: "message" });
  g = addNode(g, { id: "msg_4", kind: "message" });
  g = addNode(g, { id: "summary_1", kind: "message" });

  // Original sequence
  g = addEdge(g, {
    id: "seq:m1:m2",
    type: "sequence",
    roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
    properties: {},
  });
  g = addEdge(g, {
    id: "seq:m2:m3",
    type: "sequence",
    roles: { predecessor: ["msg_2"], successor: ["msg_3"] },
    properties: {},
  });
  g = addEdge(g, {
    id: "seq:m3:m4",
    type: "sequence",
    roles: { predecessor: ["msg_3"], successor: ["msg_4"] },
    properties: {},
  });

  // Summary parallel path
  g = addEdge(g, {
    id: "seq:m1:s1",
    type: "sequence",
    roles: { predecessor: ["msg_1"], successor: ["summary_1"] },
    properties: {},
  });
  g = addEdge(g, {
    id: "seq:s1:m4",
    type: "sequence",
    roles: { predecessor: ["summary_1"], successor: ["msg_4"] },
    properties: {},
  });

  // Summary edge
  g = addEdge(g, {
    id: "sum:1",
    type: "summary",
    roles: { source: ["msg_2", "msg_3"], result: ["summary_1"] },
    properties: {},
  });

  return g;
}

// Helper: build a message with blocks (for mixed-level testing)
//   msg_1 has blocks: blk_1 --seq--> blk_2 --seq--> blk_3
//   msg_1 --seq--> msg_2
function buildMessageWithBlocks(): ConversationGraph {
  let g = createGraph();
  g = addNode(g, { id: "msg_1", kind: "message" });
  g = addNode(g, { id: "msg_2", kind: "message" });
  g = addNode(g, { id: "blk_1", kind: "block" });
  g = addNode(g, { id: "blk_2", kind: "block" });
  g = addNode(g, { id: "blk_3", kind: "block" });

  // Message edge: blocks compose msg_1
  g = addEdge(g, {
    id: "me:msg_1",
    type: "message",
    roles: { part: ["blk_1", "blk_2", "blk_3"], whole: ["msg_1"] },
    properties: {},
  });

  // Block sequence edges
  g = addEdge(g, {
    id: "seq:b1:b2",
    type: "sequence",
    roles: { predecessor: ["blk_1"], successor: ["blk_2"] },
    properties: {},
  });
  g = addEdge(g, {
    id: "seq:b2:b3",
    type: "sequence",
    roles: { predecessor: ["blk_2"], successor: ["blk_3"] },
    properties: {},
  });

  // Message sequence edge
  g = addEdge(g, {
    id: "seq:m1:m2",
    type: "sequence",
    roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
    properties: {},
  });

  return g;
}

describe("Active Set", () => {
  test("defaultActive returns all message nodes", () => {
    const g = buildLinearMessages();
    const active = defaultActive(g);
    expect(active.size).toBe(3);
    expect(active.has("msg_1")).toBe(true);
    expect(active.has("msg_2")).toBe(true);
    expect(active.has("msg_3")).toBe(true);
  });

  test("defaultActive swaps summarized sources for summary result", () => {
    const g = buildSummarizedGraph();
    const active = defaultActive(g);
    // msg_2 and msg_3 should be removed (summarized)
    expect(active.has("msg_2")).toBe(false);
    expect(active.has("msg_3")).toBe(false);
    // summary_1 should be added
    expect(active.has("summary_1")).toBe(true);
    // msg_1 and msg_4 should remain
    expect(active.has("msg_1")).toBe(true);
    expect(active.has("msg_4")).toBe(true);
    expect(active.size).toBe(3);
  });

  test("defaultActive ignores non-message nodes", () => {
    let g = createGraph();
    g = addNode(g, { id: "msg_1", kind: "message" });
    g = addNode(g, { id: "blk_1", kind: "block" });
    g = addNode(g, {
      id: "c1",
      kind: "chunk",
      content: { type: "text", id: "t1", runId: "r1", content: "hi" } as any,
    });
    const active = defaultActive(g);
    expect(active.size).toBe(1);
    expect(active.has("msg_1")).toBe(true);
  });

  test("fullHistoryActive returns all message nodes, ignoring summaries", () => {
    const g = buildSummarizedGraph();
    const active = fullHistoryActive(g);
    // All message-kind nodes should be active
    expect(active.has("msg_1")).toBe(true);
    expect(active.has("msg_2")).toBe(true);
    expect(active.has("msg_3")).toBe(true);
    expect(active.has("msg_4")).toBe(true);
    expect(active.has("summary_1")).toBe(true); // summary is also kind: "message"
    expect(active.size).toBe(5);
  });
});

describe("findHead", () => {
  test("finds the root of a linear sequence", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    expect(findHead(g, active)).toBe("msg_1");
  });

  test("returns null for empty active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>();
    expect(findHead(g, active)).toBeNull();
  });

  test("finds head when active set is a subset", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_2", "msg_3"]);
    expect(findHead(g, active)).toBe("msg_2");
  });
});

describe("findNextActive", () => {
  test("follows sequence edges to next active node", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    expect(findNextActive(g, "msg_1", active)).toBe("msg_2");
    expect(findNextActive(g, "msg_2", active)).toBe("msg_3");
  });

  test("returns null at end of active path", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    expect(findNextActive(g, "msg_3", active)).toBeNull();
  });

  test("skips inactive nodes", () => {
    const g = buildLinearMessages();
    // Only msg_1 and msg_3 are active — msg_2 should be skipped
    // But msg_2 is a sequence successor of msg_1, and msg_3 is a successor of msg_2
    // Since msg_2 is not active, findNextActive should try to descend into msg_2
    // msg_2 has no composition edges, so it won't descend
    // This means we can't reach msg_3 from msg_1 without msg_2 being active
    // (unless msg_2 is expanded). This is correct behavior.
    const active = new Set<NodeId>(["msg_1", "msg_3"]);
    // Without msg_2, we can't jump from msg_1 to msg_3 directly
    // (there's no sequence edge msg_1 -> msg_3)
    expect(findNextActive(g, "msg_1", active)).toBeNull();
  });

  test("descends into expanded message to find active blocks", () => {
    const g = buildMessageWithBlocks();
    // Expand msg_1: replace msg_1 with its blocks in active set
    const active = new Set<NodeId>(["blk_1", "blk_2", "blk_3", "msg_2"]);
    // From blk_3 (last block of msg_1), should climb to msg_1, then find msg_2
    expect(findNextActive(g, "blk_3", active)).toBe("msg_2");
  });

  test("descends from message into first active block", () => {
    const g = buildMessageWithBlocks();
    // msg_1 is expanded, msg_2 also exists, plus an extra msg_0 before
    let g2 = g;
    g2 = addNode(g2, { id: "msg_0", kind: "message" });
    g2 = addEdge(g2, {
      id: "seq:m0:m1",
      type: "sequence",
      roles: { predecessor: ["msg_0"], successor: ["msg_1"] },
      properties: {},
    });
    // Active: msg_0, blk_1, blk_2, blk_3, msg_2
    const active = new Set<NodeId>(["msg_0", "blk_1", "blk_2", "blk_3", "msg_2"]);
    // From msg_0, successor is msg_1 which is not active, descend into blk_1
    expect(findNextActive(g2, "msg_0", active)).toBe("blk_1");
  });
});

describe("findPrevActive", () => {
  test("follows sequence edges backwards", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    expect(findPrevActive(g, "msg_2", active)).toBe("msg_1");
    expect(findPrevActive(g, "msg_3", active)).toBe("msg_2");
  });

  test("returns null at head", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    expect(findPrevActive(g, "msg_1", active)).toBeNull();
  });

  test("climbs up from block to find previous message", () => {
    const g = buildMessageWithBlocks();
    let g2 = g;
    g2 = addNode(g2, { id: "msg_0", kind: "message" });
    g2 = addEdge(g2, {
      id: "seq:m0:m1",
      type: "sequence",
      roles: { predecessor: ["msg_0"], successor: ["msg_1"] },
      properties: {},
    });
    // Active: msg_0, blk_1, blk_2, blk_3, msg_2
    const active = new Set<NodeId>(["msg_0", "blk_1", "blk_2", "blk_3", "msg_2"]);
    // From blk_1, should climb to msg_1, then find predecessor msg_0
    expect(findPrevActive(g2, "blk_1", active)).toBe("msg_0");
  });
});

describe("descendToFirstActive", () => {
  test("returns null for node with no composition edges", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1"]);
    expect(descendToFirstActive(g, "msg_2", active)).toBeNull();
  });

  test("descends message to first active block", () => {
    const g = buildMessageWithBlocks();
    const active = new Set<NodeId>(["blk_1", "blk_2", "blk_3"]);
    expect(descendToFirstActive(g, "msg_1", active)).toBe("blk_1");
  });

  test("skips inactive blocks to find first active one", () => {
    const g = buildMessageWithBlocks();
    // Only blk_2 and blk_3 are active
    const active = new Set<NodeId>(["blk_2", "blk_3"]);
    expect(descendToFirstActive(g, "msg_1", active)).toBe("blk_2");
  });

  test("descends summary to first active source message", () => {
    const g = buildSummarizedGraph();
    // Active set has the source messages instead of summary
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3", "msg_4"]);
    expect(descendToFirstActive(g, "summary_1", active)).toBe("msg_2");
  });
});

describe("findAggregate", () => {
  test("returns block's message", () => {
    const g = buildMessageWithBlocks();
    expect(findAggregate(g, "blk_1")).toBe("msg_1");
    expect(findAggregate(g, "blk_2")).toBe("msg_1");
  });

  test("returns message's summary", () => {
    const g = buildSummarizedGraph();
    expect(findAggregate(g, "msg_2")).toBe("summary_1");
    expect(findAggregate(g, "msg_3")).toBe("summary_1");
  });

  test("returns null for top-level node with no aggregate", () => {
    const g = buildLinearMessages();
    expect(findAggregate(g, "msg_1")).toBeNull();
  });

  test("block to message (chunk has block aggregate)", () => {
    let g = createGraph();
    g = addNode(g, { id: "c1", kind: "chunk", content: { type: "text" } as any });
    g = addNode(g, { id: "blk_1", kind: "block" });
    g = addEdge(g, {
      id: "be:1",
      type: "block",
      roles: { part: ["c1"], whole: ["blk_1"] },
      properties: {},
    });
    expect(findAggregate(g, "c1")).toBe("blk_1");
  });
});

describe("walk", () => {
  test("walks linear messages in order", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const nodes = [...walk(g, active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
  });

  test("walks empty active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>();
    const nodes = [...walk(g, active)];
    expect(nodes).toEqual([]);
  });

  test("walks single node", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_2"]);
    const nodes = [...walk(g, active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_2"]);
  });

  test("walks summarized path (summary replaces originals)", () => {
    const g = buildSummarizedGraph();
    const active = defaultActive(g);
    const nodes = [...walk(g, active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_1", "summary_1", "msg_4"]);
  });

  test("walks full history path (originals, not summary)", () => {
    const g = buildSummarizedGraph();
    // Full history: all messages active
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3", "msg_4"]);
    const nodes = [...walk(g, active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
  });

  test("walks mixed levels: expanded message shows blocks", () => {
    const g = buildMessageWithBlocks();
    // Expand msg_1 into blocks, keep msg_2 as message
    const active = new Set<NodeId>(["blk_1", "blk_2", "blk_3", "msg_2"]);
    const nodes = [...walk(g, active)];
    expect(nodes.map((n) => n.id)).toEqual(["blk_1", "blk_2", "blk_3", "msg_2"]);
  });

  test("walks mixed levels with predecessor before expanded message", () => {
    let g = buildMessageWithBlocks();
    g = addNode(g, { id: "msg_0", kind: "message" });
    g = addEdge(g, {
      id: "seq:m0:m1",
      type: "sequence",
      roles: { predecessor: ["msg_0"], successor: ["msg_1"] },
      properties: {},
    });
    // msg_0 -> (expanded msg_1 as blocks) -> msg_2
    const active = new Set<NodeId>(["msg_0", "blk_1", "blk_2", "blk_3", "msg_2"]);
    const nodes = [...walk(g, active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_0", "blk_1", "blk_2", "blk_3", "msg_2"]);
  });
});

describe("validate", () => {
  test("valid: linear active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    expect(validate(g, active)).toBe(true);
  });

  test("valid: empty active set", () => {
    const g = buildLinearMessages();
    expect(validate(g, new Set())).toBe(true);
  });

  test("invalid: node with two active successors", () => {
    // Create a fork: msg_1 -> msg_2 and msg_1 -> msg_3
    let g = createGraph();
    g = addNode(g, { id: "msg_1", kind: "message" });
    g = addNode(g, { id: "msg_2", kind: "message" });
    g = addNode(g, { id: "msg_3", kind: "message" });
    g = addEdge(g, {
      id: "seq:m1:m2",
      type: "sequence",
      roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
      properties: {},
    });
    g = addEdge(g, {
      id: "seq:m1:m3",
      type: "sequence",
      roles: { predecessor: ["msg_1"], successor: ["msg_3"] },
      properties: {},
    });
    // Both successors active — ambiguous
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    expect(validate(g, active)).toBe(false);
  });

  test("valid: fork with only one branch active", () => {
    let g = createGraph();
    g = addNode(g, { id: "msg_1", kind: "message" });
    g = addNode(g, { id: "msg_2", kind: "message" });
    g = addNode(g, { id: "msg_3", kind: "message" });
    g = addEdge(g, {
      id: "seq:m1:m2",
      type: "sequence",
      roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
      properties: {},
    });
    g = addEdge(g, {
      id: "seq:m1:m3",
      type: "sequence",
      roles: { predecessor: ["msg_1"], successor: ["msg_3"] },
      properties: {},
    });
    // Only one branch active
    const active = new Set<NodeId>(["msg_1", "msg_2"]);
    expect(validate(g, active)).toBe(true);
  });

  test("valid: summarized graph with default active set", () => {
    const g = buildSummarizedGraph();
    const active = defaultActive(g);
    expect(validate(g, active)).toBe(true);
  });
});
