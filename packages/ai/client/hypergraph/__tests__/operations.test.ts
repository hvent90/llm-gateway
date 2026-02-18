import { describe, test, expect } from "bun:test";
import { createGraph, addNode, addEdge } from "../primitives";
import { walk, findHead, findPrevActive } from "../walk";
import type { ConversationGraph, ConversationNode, NodeId } from "../types";
import { expand, collapse, append, summarize, branch, toggle } from "../operations";

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

// Helper: build a message with blocks
//   msg_1 has blocks: blk_1 --seq--> blk_2 --seq--> blk_3
//   msg_1 --seq--> msg_2
function buildMessageWithBlocks(): ConversationGraph {
  let g = createGraph();
  g = addNode(g, { id: "msg_1", kind: "message" });
  g = addNode(g, { id: "msg_2", kind: "message" });
  g = addNode(g, { id: "blk_1", kind: "block" });
  g = addNode(g, { id: "blk_2", kind: "block" });
  g = addNode(g, { id: "blk_3", kind: "block" });

  g = addEdge(g, {
    id: "me:msg_1",
    type: "message",
    roles: { part: ["blk_1", "blk_2", "blk_3"], whole: ["msg_1"] },
    properties: {},
  });
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
  g = addEdge(g, {
    id: "seq:m1:m2",
    type: "sequence",
    roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
    properties: {},
  });
  return g;
}

// Helper: build a summarized graph
//   msg_1 --seq--> msg_2 --seq--> msg_3 --seq--> msg_4
//            \                           /
//             --seq--> summary_1 --seq--
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

describe("expand", () => {
  test("expands a message into its blocks", () => {
    const g = buildMessageWithBlocks();
    const active = new Set<NodeId>(["msg_1", "msg_2"]);
    const result = expand(g, active, "msg_1");
    expect(result.has("msg_1")).toBe(false);
    expect(result.has("blk_1")).toBe(true);
    expect(result.has("blk_2")).toBe(true);
    expect(result.has("blk_3")).toBe(true);
    expect(result.has("msg_2")).toBe(true);
    expect(result.size).toBe(4);
  });

  test("expands a summary into its sources", () => {
    const g = buildSummarizedGraph();
    const active = new Set<NodeId>(["msg_1", "summary_1", "msg_4"]);
    const result = expand(g, active, "summary_1");
    expect(result.has("summary_1")).toBe(false);
    expect(result.has("msg_2")).toBe(true);
    expect(result.has("msg_3")).toBe(true);
    expect(result.has("msg_1")).toBe(true);
    expect(result.has("msg_4")).toBe(true);
    expect(result.size).toBe(4);
  });

  test("returns same active set if node has no composition edges", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const result = expand(g, active, "msg_2");
    expect(result).toEqual(active);
  });

  test("does not mutate the original active set", () => {
    const g = buildMessageWithBlocks();
    const active = new Set<NodeId>(["msg_1", "msg_2"]);
    expand(g, active, "msg_1");
    expect(active.has("msg_1")).toBe(true);
    expect(active.size).toBe(2);
  });

  test("expanded set walks correctly", () => {
    const g = buildMessageWithBlocks();
    const active = new Set<NodeId>(["msg_1", "msg_2"]);
    const expanded = expand(g, active, "msg_1");
    const nodes = [...walk(g, expanded)];
    expect(nodes.map((n) => n.id)).toEqual(["blk_1", "blk_2", "blk_3", "msg_2"]);
  });
});

describe("collapse", () => {
  test("collapses blocks back into their message", () => {
    const g = buildMessageWithBlocks();
    const active = new Set<NodeId>(["blk_1", "blk_2", "blk_3", "msg_2"]);
    const result = collapse(g, active, ["blk_1", "blk_2", "blk_3"]);
    expect(result.has("blk_1")).toBe(false);
    expect(result.has("blk_2")).toBe(false);
    expect(result.has("blk_3")).toBe(false);
    expect(result.has("msg_1")).toBe(true);
    expect(result.has("msg_2")).toBe(true);
    expect(result.size).toBe(2);
  });

  test("collapses summary sources back into summary", () => {
    const g = buildSummarizedGraph();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3", "msg_4"]);
    const result = collapse(g, active, ["msg_2", "msg_3"]);
    expect(result.has("msg_2")).toBe(false);
    expect(result.has("msg_3")).toBe(false);
    expect(result.has("summary_1")).toBe(true);
    expect(result.has("msg_1")).toBe(true);
    expect(result.has("msg_4")).toBe(true);
    expect(result.size).toBe(3);
  });

  test("returns same active set if no grouping edge found", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const result = collapse(g, active, ["msg_1", "msg_2"]);
    expect(result).toEqual(active);
  });

  test("does not mutate the original active set", () => {
    const g = buildMessageWithBlocks();
    const active = new Set<NodeId>(["blk_1", "blk_2", "blk_3", "msg_2"]);
    collapse(g, active, ["blk_1", "blk_2", "blk_3"]);
    expect(active.has("blk_1")).toBe(true);
    expect(active.size).toBe(4);
  });

  test("collapse is the inverse of expand", () => {
    const g = buildMessageWithBlocks();
    const original = new Set<NodeId>(["msg_1", "msg_2"]);
    const expanded = expand(g, original, "msg_1");
    const collapsed = collapse(g, expanded, ["blk_1", "blk_2", "blk_3"]);
    expect(collapsed).toEqual(original);
  });
});

describe("append", () => {
  test("appends a message to end of linear graph", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const newMsg: ConversationNode = { id: "msg_4", kind: "message" };
    const result = append(g, active, newMsg);

    // New node exists in graph
    expect(result.graph.nodes.get("msg_4")).toBeDefined();
    // New node in active set
    expect(result.active.has("msg_4")).toBe(true);
    // Walk in order
    const nodes = [...walk(result.graph, result.active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
  });

  test("appends to a single-node graph", () => {
    let g = createGraph();
    g = addNode(g, { id: "msg_1", kind: "message" });
    const active = new Set<NodeId>(["msg_1"]);
    const newMsg: ConversationNode = { id: "msg_2", kind: "message" };
    const result = append(g, active, newMsg);

    const nodes = [...walk(result.graph, result.active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_1", "msg_2"]);
  });

  test("appends to an empty graph", () => {
    const g = createGraph();
    const active = new Set<NodeId>();
    const newMsg: ConversationNode = { id: "msg_1", kind: "message" };
    const result = append(g, active, newMsg);

    expect(result.graph.nodes.get("msg_1")).toBeDefined();
    expect(result.active.has("msg_1")).toBe(true);
    const nodes = [...walk(result.graph, result.active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_1"]);
  });

  test("does not mutate the original graph or active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const origNodeCount = g.nodes.size;
    const newMsg: ConversationNode = { id: "msg_4", kind: "message" };
    append(g, active, newMsg);
    expect(g.nodes.size).toBe(origNodeCount);
    expect(active.size).toBe(3);
  });
});

describe("summarize", () => {
  test("summarizes a range of messages", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const summaryNode: ConversationNode = { id: "sum_1", kind: "message" };
    const result = summarize(g, active, ["msg_1", "msg_2"], summaryNode);

    // Summary node exists
    expect(result.graph.nodes.get("sum_1")).toBeDefined();
    // Source nodes removed from active, summary added
    expect(result.active.has("msg_1")).toBe(false);
    expect(result.active.has("msg_2")).toBe(false);
    expect(result.active.has("sum_1")).toBe(true);
    expect(result.active.has("msg_3")).toBe(true);
    // Walk follows summary path
    const nodes = [...walk(result.graph, result.active)];
    expect(nodes.map((n) => n.id)).toEqual(["sum_1", "msg_3"]);
  });

  test("summarizes middle messages, preserving head and tail", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const summaryNode: ConversationNode = { id: "sum_1", kind: "message" };
    const result = summarize(g, active, ["msg_2"], summaryNode);

    expect(result.active.has("msg_1")).toBe(true);
    expect(result.active.has("msg_2")).toBe(false);
    expect(result.active.has("sum_1")).toBe(true);
    expect(result.active.has("msg_3")).toBe(true);
    const nodes = [...walk(result.graph, result.active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_1", "sum_1", "msg_3"]);
  });

  test("summarizes tail messages", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const summaryNode: ConversationNode = { id: "sum_1", kind: "message" };
    const result = summarize(g, active, ["msg_2", "msg_3"], summaryNode);

    const nodes = [...walk(result.graph, result.active)];
    expect(nodes.map((n) => n.id)).toEqual(["msg_1", "sum_1"]);
  });

  test("does not mutate the original graph", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const origNodeCount = g.nodes.size;
    const summaryNode: ConversationNode = { id: "sum_1", kind: "message" };
    summarize(g, active, ["msg_2"], summaryNode);
    expect(g.nodes.size).toBe(origNodeCount);
  });
});

describe("branch", () => {
  test("branches from a middle node includes everything up to that node", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const result = branch(g, active, "msg_2");
    expect(result.has("msg_1")).toBe(true);
    expect(result.has("msg_2")).toBe(true);
    expect(result.has("msg_3")).toBe(false);
    expect(result.size).toBe(2);
  });

  test("branches from head returns only head", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const result = branch(g, active, "msg_1");
    expect(result.has("msg_1")).toBe(true);
    expect(result.size).toBe(1);
  });

  test("branches from tail returns full active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const result = branch(g, active, "msg_3");
    expect(result).toEqual(active);
  });

  test("does not mutate the original active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    branch(g, active, "msg_2");
    expect(active.size).toBe(3);
  });

  test("does not mutate the graph", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const edgeCount = g.edges.size;
    branch(g, active, "msg_2");
    expect(g.edges.size).toBe(edgeCount);
  });
});

describe("toggle", () => {
  test("removes a node that is in the active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    const result = toggle(g, active, "msg_2");
    expect(result.has("msg_2")).toBe(false);
    expect(result.has("msg_1")).toBe(true);
    expect(result.has("msg_3")).toBe(true);
    expect(result.size).toBe(2);
  });

  test("adds a node that is not in the active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_3"]);
    const result = toggle(g, active, "msg_2");
    expect(result.has("msg_2")).toBe(true);
    expect(result.size).toBe(3);
  });

  test("does not mutate the original active set", () => {
    const g = buildLinearMessages();
    const active = new Set<NodeId>(["msg_1", "msg_2", "msg_3"]);
    toggle(g, active, "msg_2");
    expect(active.size).toBe(3);
  });
});
