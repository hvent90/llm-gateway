# Hypergraph Force-Graph Visualization — Design

**Goal:** Add an alternate UI view that renders the conversation hypergraph as an interactive force-directed graph with convex hull groupings, live updates, and expand/collapse navigation.

## Requirements

- Toggle between Chat and Graph views in the same page, sharing `ConversationState`
- User-facing visualization (not raw debug view)
- All three hierarchy levels visible: chunk, block, message
- Convex hulls to show hyperedge membership (part/whole containment)
- Expand/collapse on click — drill into messages → blocks → chunks and back
- Hover details via tooltip
- Live updates as events stream in
- Pan, zoom

## Tech Stack

- `react-force-graph-2d` — Force layout, interactions, React component
- Canvas API — Custom hull rendering via `onRenderFramePost`
- Existing hypergraph SDK — `expand`, `collapse`, `defaultActive`, graph queries

## Data Mapping

### Nodes

One force-graph node per visible `ConversationNode`, styled by kind:

| Kind    | Shape        | Color by                                    |
|---------|-------------|---------------------------------------------|
| chunk   | small dot   | event type (blue=text, orange=tool, green=user, gray=harness, red=error) |
| block   | medium circle | block type                                |
| message | large circle | role (user/assistant)                      |

### Links

Only peer-to-peer edges become force-graph links:

| Edge Type | Rendering              | Meaning               |
|-----------|------------------------|----------------------|
| sequence  | directional arrow      | ordering             |
| spawn     | dashed line            | subagent invocation  |

### Hulls (not links)

Containment edges rendered as convex hull bubbles:

| Edge Type | Hull wraps           | Visual style                    |
|-----------|---------------------|---------------------------------|
| block     | chunk nodes (part)  | translucent, colored by type    |
| message   | block nodes (part)  | translucent, neutral color      |
| summary   | source nodes        | translucent, dotted border      |

## Expand / Collapse

Default: only message-level nodes visible (from `defaultActive(graph)`).

- Click message node → `expand(graph, active, messageId)` → shows block children inside message hull
- Click block node → `expand(graph, active, blockId)` → shows chunk children inside block hull
- Click hull → `collapse(graph, active, childIds)` → children collapse back to parent

Component maintains local `active: Set<NodeId>` state.

## Hover Details

Tooltip shows:
- **Chunks**: event type, runId, content preview
- **Blocks**: block type, chunk count
- **Messages**: block count, role (user/assistant)
- **Hulls**: edge type, role info

## Live Updates

`projectForceGraph(graph, active)` recomputes on every `state.graph` change. The `graphData` prop update triggers smooth force simulation adjustment. New nodes appear and settle into position.

## Projection Function

`projectForceGraph(graph: ConversationGraph, active: Set<NodeId>)` returns:

```typescript
{
  nodes: Array<{ id: string; kind: string; label: string; color: string; size: number; ... }>,
  links: Array<{ source: string; target: string; type: string; style: string; ... }>,
  hulls: Array<{ edgeId: string; edgeType: string; nodeIds: string[]; color: string; ... }>
}
```

## Component Structure

```
App.tsx
├── <ViewToggle />           ← Chat | Graph switch in header
├── <ConversationThread />   ← existing, shown when mode=chat
└── <GraphView />            ← new, shown when mode=graph
    ├── projectForceGraph()  ← projection: graph + active → { nodes, links, hulls }
    ├── computeHulls()       ← canvas geometry for convex hull paths
    └── <ForceGraph2D />     ← react-force-graph-2d with custom rendering
```
