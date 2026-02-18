import { describe, it, expect } from "bun:test";
import { summarizeFromEvents } from "../summarize";
import { createGraph, addNode, addEdge } from "../hypergraph/primitives";
import type { ConversationGraph, NodeId } from "../hypergraph/types";
import { walk } from "../hypergraph/walk";

describe("summarizeFromEvents", () => {
  function buildSimpleGraph(): { graph: ConversationGraph; active: Set<NodeId> } {
    let g = createGraph();
    g = addNode(g, { id: "msg_1", kind: "message" });
    g = addNode(g, { id: "msg_2", kind: "message" });
    g = addNode(g, { id: "msg_3", kind: "message" });
    g = addEdge(g, {
      id: "seq:1:2",
      type: "sequence",
      roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
      properties: {},
    });
    g = addEdge(g, {
      id: "seq:2:3",
      type: "sequence",
      roles: { predecessor: ["msg_2"], successor: ["msg_3"] },
      properties: {},
    });
    return { graph: g, active: new Set(["msg_1", "msg_2", "msg_3"]) };
  }

  it("creates summary node and wires it into graph", () => {
    const { graph, active } = buildSimpleGraph();
    const result = summarizeFromEvents(graph, active, ["msg_1", "msg_2"], "Summary of msgs 1-2");

    // Source nodes removed, summary added
    expect(result.active.has("msg_1")).toBe(false);
    expect(result.active.has("msg_2")).toBe(false);
    expect(result.active.size).toBe(2); // summary + msg_3

    // Walk should include summary then msg_3
    const walked = [...walk(result.graph, result.active)].map((n) => n.id);
    expect(walked.length).toBe(2);
    expect(walked[1]).toBe("msg_3");
    // First should be the summary node
    expect(walked[0]).not.toBe("msg_1");
    expect(walked[0]).not.toBe("msg_2");
  });

  it("returns the summary node id", () => {
    const { graph, active } = buildSimpleGraph();
    const result = summarizeFromEvents(graph, active, ["msg_2"], "Summary of msg 2");
    expect(result.summaryNodeId).toBeDefined();
    expect(result.active.has(result.summaryNodeId)).toBe(true);
  });
});
