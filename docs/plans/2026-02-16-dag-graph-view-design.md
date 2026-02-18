# DAG Graph View Design

Replace the force-directed graph visualization with a custom DAG layout using HTML nodes + SVG edges. No physics simulation, no d3, no external layout libraries.

## Problem

The current graph view uses `react-force-graph-2d` (d3 force simulation) to render the conversation hypergraph. Force-directed layout is the wrong algorithm for a DAG — nodes tangle, positions are semantically meaningless, and ~85 lines of ref-juggling exist solely to prevent d3 from destroying its own output on updates. The result doesn't resemble a readable flowchart.

## Decisions

- **Custom DAG layout**: Deterministic top-to-bottom positioning. One pass, no iteration.
- **HTML nodes + SVG edges**: Native text rendering, CSS styling, accessibility, text selection. No canvas.
- **Nested columns** for subagent spawns (git-graph style).
- **Parallel columns** for conversation forks. Active branch full opacity, inactive branches dimmed. Click to switch.
- **Click to expand/collapse** message groups and summary groups.
- **Inline relay buttons** on pending tool_call nodes.
- **Pan/zoom canvas** with minimap and keyboard navigation.
- **Zero new dependencies**. Delete `react-force-graph-2d` and `d3-force-3d`.

## Architecture

### Data Flow

```
ConversationGraph
  → projectDAG(graph, active, pendingRelays)
  → DAGLayout { nodes, edges, groups, totalWidth, totalHeight }
  → <GraphView> renders at assigned (x, y) positions
```

Layout is computed inside the projection, not by the renderer. The React component just positions elements.

### DAG Layout Types

```ts
interface DAGNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  blockType: "text" | "reasoning" | "tool_call" | "tool_result" | "user" | "error" | "structural";
  label: string;
  color: string;
  borderColor: string;
  hasPendingRelay: boolean;
}

interface DAGEdge {
  source: string;
  target: string;
  type: "sequence" | "spawn";
}

interface DAGGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  borderColor: string;
  edgeType: "message" | "summary";
  collapsed: boolean;
}

interface DAGLayout {
  nodes: DAGNode[];
  edges: DAGEdge[];
  groups: DAGGroup[];
  totalWidth: number;
  totalHeight: number;
}
```

### Layout Algorithm

1. Walk the graph top-to-bottom following sequence edges.
2. Each node's `y` = previous node's `y` + previous node's `height` + gap.
3. Main conversation spine at `x = 0`.
4. Subagent spawn branches offset right: `x = parentColumn.x + parentColumn.width + columnGap`.
5. Conversation fork branches: active branch stays in current column, inactive branches offset right and rendered dimmed.
6. Message group bounding box = rect from first child's top to last child's bottom.
7. Summary group bounding box = rect around source messages when expanded, single summary node when collapsed.
8. Node sizing: measure text with an offscreen canvas context (one-time during projection).

### Rendering

```
<GraphView>
  <PanZoomContainer>              -- div with transform: translate(tx,ty) scale(s)
    <svg>                         -- edges + groups layer (behind nodes)
      <rect> per group            -- message/summary bounding boxes
      <path> per edge             -- sequence edges, spawn edges
    </svg>
    <div> per node                -- absolutely positioned HTML nodes
      type label
      content text                -- native word wrap
      [relay buttons]             -- if pending relay
  <Minimap />                     -- fixed overlay
  <ZoomControls />                -- fixed overlay
  <JumpToLatest />                -- shown when auto-follow is off
```

SVG and HTML nodes share the same transformed container, so coordinates are unified. No sync issues.

### Pan/Zoom

Custom `usePanZoom()` hook (~80 lines):
- Tracks `{ tx, ty, scale }` in a ref, applies via imperative `style.transform`.
- Mouse wheel zooms (centered on cursor).
- Click-drag on empty space pans.
- Pinch-to-zoom on trackpad/touch.

### Interactions

- **Hover**: Brighter border, pointer cursor.
- **Click message group**: Toggle expand/collapse. Collapsed = single summary line. Expanded = all child blocks.
- **Click summary group**: Toggle expand/collapse. Collapsed = summary node. Expanded = original source messages.
- **Click inactive fork branch**: Switch active set to that branch.
- **Relay approval**: tool_call nodes with pending relays show amber border + pulsing glow + Allow/AllowAll/Deny buttons inline. Viewport auto-scrolls to relay node.
- **Keyboard**: Arrow keys move selection (up/down = sequence, left/right = fork branches). Enter = expand/collapse. Home/End = jump to start/end.
- **Streaming**: Auto-scroll to latest node unless user has manually panned away. "Jump to latest" button when auto-follow is off.
- **Fork badges**: Fork points show branch count (e.g., "1/3").

### Edges

- **Sequence edges**: Vertical lines between nodes in the same column.
- **Spawn edges**: L-shaped or bezier curves from source node's right side to target node's top.
- **Arrowheads**: SVG `<marker>` elements.
- **Styling**: Solid gray for sequence, dashed pink for spawn (same colors as current).

## File Inventory

### Delete

- `clients/web/src/components/GraphView.tsx`
- `clients/web/src/lib/convex-hull.ts`
- `clients/web/src/__tests__/convex-hull.test.ts`
- `packages/ai/client/hypergraph/projections/force-graph.ts`
- `packages/ai/client/hypergraph/__tests__/projections/force-graph.test.ts`

### Create

- `packages/ai/client/hypergraph/projections/dag.ts` — projection + layout
- `packages/ai/client/hypergraph/__tests__/projections/dag.test.ts` — layout tests
- `clients/web/src/components/GraphView.tsx` — new renderer
- `clients/web/src/hooks/usePanZoom.ts` — pan/zoom hook
- `clients/web/src/components/graph/DAGNode.tsx` — node component
- `clients/web/src/components/graph/DAGEdge.tsx` — SVG edge path
- `clients/web/src/components/graph/DAGGroup.tsx` — SVG bounding box
- `clients/web/src/components/graph/Minimap.tsx` — minimap overlay
- `clients/web/src/components/graph/ZoomControls.tsx` — zoom controls

### Modify

- `clients/web/src/App.tsx` — pass `pendingRelays` + `permissionHandlers` to GraphView
- `clients/web/src/types.ts` — swap force-graph type re-exports for DAG types
- `package.json` — remove `react-force-graph-2d`, `d3-force-3d`

### Untouched

- All hypergraph core (types, primitives, reducer, conversation, walk, operations, queries, derived)
- Thread projection, messages projection
- ConversationThread, InputArea
- Server-side code, transports
