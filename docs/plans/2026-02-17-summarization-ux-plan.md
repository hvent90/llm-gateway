# Summarization UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add message selection, summarization trigger, and summary expand/collapse to the web client's conversation thread.

**Architecture:** Selection state is local to ConversationThread. Message node IDs are derived by walking the active set and correlating with rendered MessageGroups by index. Summarization calls `POST /summarize` via a new SSE stream in App.tsx, then wires the result into the hypergraph via `summarizeFromEvents()`. Summary nodes are detected via `sourcesOf()` and rendered with distinct styling and expand/collapse controls that call `operations.expand()`/`operations.collapse()`.

**Tech Stack:** React, TailwindCSS, existing hypergraph operations, existing SSE transport pattern.

---

### Task 1: Pass active set and graph operations to ConversationThread

**Files:**
- Modify: `clients/web/src/App.tsx`
- Modify: `clients/web/src/components/ConversationThread.tsx`

**Context:** Currently ConversationThread receives only `graph`, `pendingRelays`, and `permissionHandlers`. We need to add `active` (for message ID lookup), `onSummarize`, `onExpand`, and `onCollapse` callbacks. We also need the `selectedModel` to be available for the summarize call, but that's App's concern — the thread just calls `onSummarize(sourceIds, messages)`.

**Step 1: Update ConversationThreadProps**

In `clients/web/src/components/ConversationThread.tsx`, add to the `ConversationThreadProps` interface:

```typescript
interface ConversationThreadProps {
  graph: ConversationGraph;
  active: Set<NodeId>;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  onSummarize: (sourceIds: string[], messages: Message[]) => void;
  onExpand: (nodeId: string) => void;
  onCollapse: (nodeIds: string[]) => void;
  isSummarizing: boolean;
}
```

Add these imports at the top of ConversationThread.tsx:

```typescript
import { walk } from "../../../../packages/ai/client/hypergraph";
import { sourcesOf } from "../../../../packages/ai/client/hypergraph";
import { deriveMessageContent } from "../../../../packages/ai/client/hypergraph";
import type { NodeId } from "../types";
import type { Message } from "../types";
```

**Step 2: Update the ConversationThread export to accept and use the new props**

Update the `ConversationThread` function signature to destructure all new props and pass `active` to the `Thread` component:

```typescript
export function ConversationThread({
  graph,
  active,
  pendingRelays,
  permissionHandlers,
  onSummarize,
  onExpand,
  onCollapse,
  isSummarizing,
}: ConversationThreadProps) {
```

**Step 3: Update App.tsx to pass the new props**

In `App.tsx`, add placeholder handlers and pass them along with `state.active`:

```typescript
const handleSummarize = useCallback(
  async (sourceIds: string[], messages: Message[]) => {
    // Will be implemented in Task 4
    console.log("summarize", sourceIds, messages);
  },
  [],
);

const handleExpand = useCallback(
  (nodeId: string) => {
    // Will be implemented in Task 5
    console.log("expand", nodeId);
  },
  [],
);

const handleCollapse = useCallback(
  (nodeIds: string[]) => {
    // Will be implemented in Task 5
    console.log("collapse", nodeIds);
  },
  [],
);
```

And update the `<ConversationThread>` JSX:

```tsx
<ConversationThread
  graph={state.graph}
  active={state.active}
  pendingRelays={state.pendingRelays}
  permissionHandlers={permissionHandlers}
  onSummarize={handleSummarize}
  onExpand={handleExpand}
  onCollapse={handleCollapse}
  isSummarizing={false}
/>
```

Import `NodeId` type and add `active` to types.ts re-exports if not already there.

**Step 4: Verify the web client still renders correctly**

Run: `bun run dev:web`
Expected: Chat view renders as before with no visual changes.

**Step 5: Commit**

```bash
git add clients/web/src/App.tsx clients/web/src/components/ConversationThread.tsx clients/web/src/types.ts
git commit -m "refactor: pass active set and graph operation callbacks to ConversationThread"
```

---

### Task 2: Add message selection with checkboxes

**Files:**
- Modify: `clients/web/src/components/ConversationThread.tsx`

**Context:** Each MessageGroup in the thread needs a checkbox. Selection state is local to ConversationThread. We need to map each MessageGroup to its message node ID by walking the active set and correlating by index. MessageGroups from `groupNodes()` are in the same order as `walk(graph, active)` in the common case.

**Key data model insight:** Message node IDs are `msg:1`, `msg:2`, etc. (from reducer.ts `flushMessage`). The `walk(graph, active)` function returns these in sequence order. `groupNodes(viewNodes)` groups ViewNodes by runId, producing groups in the same visual order.

**Step 1: Add selection state and message ID mapping to ConversationThread**

In the `ConversationThread` function body (before the return), add:

```typescript
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

// Map groups to message node IDs by walking the active set
const messageIds = [...walk(graph, active)].map((n) => n.id);
```

Also add `useState` to the React imports at the top if not already there (it is — check for `useState` in the import).

**Step 2: Add selection props to MessageGroupComponent**

Update the `MessageGroupComponent` to accept selection props:

```typescript
const MessageGroupComponent = memo(function MessageGroupComponent({
  group,
  pendingRelays,
  permissionHandlers,
  messageId,
  selected,
  anySelected,
  onToggleSelect,
}: {
  group: MessageGroup;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  messageId: string | undefined;
  selected: boolean;
  anySelected: boolean;
  onToggleSelect: () => void;
}) {
```

**Step 3: Render checkbox in MessageGroupComponent**

Add the checkbox to the message group header. It appears on hover, or always when any message is selected:

```tsx
return (
  <div className="group relative mb-4">
    {messageId && (
      <div
        className={`absolute -left-6 top-0 flex h-6 w-6 items-center justify-center ${
          anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
        />
      </div>
    )}
    <div className={`font-bold ${isUser ? "text-white" : "text-green-400"}`}>
      {/* ... existing header content ... */}
    </div>
    {/* ... existing node rendering ... */}
  </div>
);
```

**Step 4: Wire selection in the Thread component**

Update the `Thread` component to pass selection props. The `Thread` is used both at the top level and inside `BranchView` for subagent branches. Only top-level gets selection:

```typescript
function Thread({
  nodes,
  pendingRelays,
  permissionHandlers,
  messageIds,
  selectedIds,
  anySelected,
  onToggleSelect,
}: {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  messageIds?: string[];
  selectedIds?: Set<string>;
  anySelected?: boolean;
  onToggleSelect?: (index: number, shiftKey: boolean) => void;
}) {
  const groups = groupNodes(nodes);

  return (
    <>
      {groups.map((group, i) => {
        const msgId = messageIds?.[i];
        return (
          <MessageGroupComponent
            key={`${group.runId}-${group.nodes[0]!.id}`}
            group={group}
            pendingRelays={pendingRelays}
            permissionHandlers={permissionHandlers}
            messageId={msgId}
            selected={msgId ? (selectedIds?.has(msgId) ?? false) : false}
            anySelected={anySelected ?? false}
            onToggleSelect={() => onToggleSelect?.(i, false)}
          />
        );
      })}
    </>
  );
}
```

**Step 5: Implement toggle logic in ConversationThread**

In the `ConversationThread` body, add the toggle handler:

```typescript
const handleToggleSelect = useCallback(
  (index: number, shiftKey: boolean) => {
    const msgId = messageIds[index];
    if (!msgId) return;

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastClickedIndex !== null) {
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);
        for (let i = start; i <= end; i++) {
          const id = messageIds[i];
          if (id) next.add(id);
        }
      } else if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
    setLastClickedIndex(index);
  },
  [messageIds, lastClickedIndex],
);
```

Pass these to the top-level `Thread`:

```tsx
<Thread
  nodes={viewNodes}
  pendingRelays={pendingRelays}
  permissionHandlers={permissionHandlers}
  messageIds={messageIds}
  selectedIds={selectedIds}
  anySelected={selectedIds.size > 0}
  onToggleSelect={handleToggleSelect}
/>
```

**Step 6: Add left padding for checkbox space**

The thread container needs left padding so checkboxes don't overlap. In the `ConversationThread` return:

```tsx
return (
  <div className="space-y-4 pl-6">
    {/* ... */}
  </div>
);
```

**Step 7: Verify selection works visually**

Run: `bun run dev:web`
Expected: Hover over a message group → checkbox appears on the left. Click to select → checkbox stays visible on all groups. Click another → both selected. Click again → deselected.

**Step 8: Commit**

```bash
git add clients/web/src/components/ConversationThread.tsx
git commit -m "feat(web): add message selection checkboxes to conversation thread"
```

---

### Task 3: Add inline "Summarize" button

**Files:**
- Modify: `clients/web/src/components/ConversationThread.tsx`

**Context:** When messages are selected, an inline "Summarize N messages" button appears after the last selected message group. Clicking it extracts message content via `deriveMessageContent()`, calls `onSummarize`, and clears selection.

**Step 1: Find the last selected group index**

In ConversationThread, after computing messageIds and groups (inside the component body):

```typescript
const lastSelectedGroupIndex = messageIds.reduce(
  (last, id, i) => (selectedIds.has(id) ? i : last),
  -1,
);
```

**Step 2: Render the summarize button in Thread**

Pass `lastSelectedGroupIndex`, `onSummarize`, `selectedIds`, and `isSummarizing` to Thread. After the MessageGroupComponent at `lastSelectedGroupIndex`, render the button:

In the Thread component's map, after each `MessageGroupComponent`:

```tsx
{groups.map((group, i) => {
  const msgId = messageIds?.[i];
  return (
    <React.Fragment key={`${group.runId}-${group.nodes[0]!.id}`}>
      <MessageGroupComponent
        /* ... existing props ... */
      />
      {i === lastSelectedGroupIndex && selectedIds && selectedIds.size > 0 && (
        <div className="my-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onSummarizeClick}
            disabled={isSummarizing}
            className="border border-blue-800 bg-blue-950 px-3 py-1 text-sm text-blue-300 hover:bg-blue-900 disabled:opacity-50"
          >
            {isSummarizing ? "Summarizing..." : `Summarize ${selectedIds.size} messages`}
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            className="px-2 py-1 text-sm text-neutral-500 hover:text-white"
          >
            cancel
          </button>
        </div>
      )}
    </React.Fragment>
  );
})}
```

**Step 3: Implement the summarize click handler**

In ConversationThread:

```typescript
const handleSummarizeClick = useCallback(() => {
  if (selectedIds.size === 0) return;
  const sourceIds = [...selectedIds];
  const messages: Message[] = [];
  for (const id of sourceIds) {
    messages.push(...deriveMessageContent(graph, id));
  }
  onSummarize(sourceIds, messages);
  setSelectedIds(new Set());
  setLastClickedIndex(null);
}, [selectedIds, graph, onSummarize]);
```

Pass `handleSummarizeClick`, `() => { setSelectedIds(new Set()); setLastClickedIndex(null); }` (clear handler), `lastSelectedGroupIndex`, and `isSummarizing` to Thread.

**Step 4: Verify the button appears and works**

Run: `bun run dev:web`
Expected: Select 2 messages → "Summarize 2 messages" button appears inline after the last selected message. Click it → console.log fires with sourceIds and messages (from Task 1 placeholder). Selection clears.

**Step 5: Commit**

```bash
git add clients/web/src/components/ConversationThread.tsx
git commit -m "feat(web): add inline summarize button for selected messages"
```

---

### Task 4: Implement summarization in App.tsx

**Files:**
- Modify: `clients/web/src/App.tsx`

**Context:** Replace the placeholder `handleSummarize` with a real implementation that streams `POST /summarize` via SSE, collects text events, and wires the summary into the hypergraph.

**Key pattern:** The `/summarize` endpoint returns SSE events in the same format as `/chat`. We need a lightweight SSE stream consumer that doesn't go through the orchestrator — just collect text events and we're done. We can reuse the same `parseSSE` from `transports/sse.ts` pattern.

**Step 1: Add `isSummarizing` state to App**

```typescript
const [isSummarizing, setIsSummarizing] = useState(false);
```

Pass it to ConversationThread:

```tsx
<ConversationThread
  /* ... */
  isSummarizing={isSummarizing}
/>
```

**Step 2: Implement handleSummarize**

Replace the placeholder with:

```typescript
import { summarizeFromEvents } from "../../../packages/ai/client/summarize";
import { expand, collapse } from "../../../packages/ai/client/hypergraph";

const handleSummarize = useCallback(
  async (sourceIds: string[], messages: Message[]) => {
    setIsSummarizing(true);
    try {
      const response = await fetch("/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          sourceIds,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Collect all text from the SSE stream
      const text = await response.text();
      let summaryText = "";
      for (const block of text.split("\n\n")) {
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "text") {
                summaryText += event.content;
              }
            } catch {}
          }
        }
      }

      if (summaryText) {
        setState((s) => {
          const result = summarizeFromEvents(s.graph, s.active, sourceIds, summaryText);
          return { ...s, graph: result.graph, active: result.active };
        });
      }
    } catch (error) {
      console.error("Summarize error:", error);
      setStreamError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSummarizing(false);
    }
  },
  [selectedModel],
);
```

**Step 3: Verify end-to-end summarization**

Run: `bun run dev:web` (and `bun run dev` for the server)
Expected: Have a conversation with a few messages. Select 2-3 messages. Click "Summarize". After a moment, the selected messages are replaced by a single summary message in the thread.

**Step 4: Commit**

```bash
git add clients/web/src/App.tsx
git commit -m "feat(web): implement summarize handler with SSE streaming"
```

---

### Task 5: Summary display with expand/collapse

**Files:**
- Modify: `clients/web/src/components/ConversationThread.tsx`
- Modify: `clients/web/src/App.tsx`

**Context:** Summary message nodes need distinct styling (dashed border, label) and an expand/collapse toggle. Detection: a message node is a summary if `sourcesOf(graph, messageId)` returns non-empty. The expand/collapse callbacks update the graph's active set via `operations.expand()`/`operations.collapse()`.

**Step 1: Implement expand/collapse handlers in App.tsx**

Replace the placeholder handlers:

```typescript
const handleExpand = useCallback(
  (nodeId: string) => {
    setState((s) => ({
      ...s,
      active: expand(s.graph, s.active, nodeId),
    }));
  },
  [],
);

const handleCollapse = useCallback(
  (nodeIds: string[]) => {
    setState((s) => ({
      ...s,
      active: collapse(s.graph, s.active, nodeIds),
    }));
  },
  [],
);
```

**Step 2: Detect and render summary nodes in ConversationThread**

In the Thread component, check if a message node is a summary. Pass `graph`, `onExpand`, `onCollapse` to Thread and MessageGroupComponent.

In MessageGroupComponent, add summary detection and rendering:

```typescript
// In MessageGroupComponent, add:
const sources = messageId ? sourcesOf(graph, messageId) : [];
const isSummary = sources.length > 0;
```

Wrap the message group content with summary styling when `isSummary` is true:

```tsx
return (
  <div className={`group relative mb-4 ${isSummary ? "border-l-2 border-dashed border-blue-800 pl-3" : ""}`}>
    {isSummary && (
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-blue-400">Summary</span>
        <button
          type="button"
          onClick={() => onExpand?.(messageId!)}
          className="text-xs text-neutral-500 hover:text-white"
        >
          show {sources.length} original messages
        </button>
      </div>
    )}
    {/* ... existing checkbox and content ... */}
  </div>
);
```

**Step 3: Add collapse control for expanded summaries**

When a summary is expanded (source messages are visible instead of summary), we need a way to collapse back. The source messages won't individually show a collapse button — instead, we detect if a group of messages has a summary via `summariesOf()`. Add this to the Thread component.

Import `summariesOf` from the hypergraph queries.

In the Thread component, after rendering all groups, check if the current selection of visible messages can be collapsed back into a summary:

Actually, the simpler approach: when the summary is expanded, the summary node is removed from the active set and the source messages are back. The `sourcesOf` check on the summary node won't trigger because the summary isn't in the active set anymore. Instead, check if any visible message has a `summariesOf()` result — meaning there exists a summary for it.

For the POC, add a "Collapse to summary" button that appears when viewing expanded source messages. Check the first message in the group: if `summariesOf(graph, messageId)` returns a non-empty array, show the collapse button.

In Thread, after the MessageGroupComponent for the last source message of a summary group, render:

```tsx
// After each group, check if this is the last source of a summary
{(() => {
  if (!msgId) return null;
  const sums = summariesOf(graph, msgId);
  if (sums.length === 0) return null;
  // Check if next group's msgId is NOT in the same summary's sources
  const nextMsgId = messageIds?.[i + 1];
  const sumSources = sourcesOf(graph, sums[0]!);
  const isLastSource = !nextMsgId || !sumSources.includes(nextMsgId);
  if (!isLastSource) return null;
  return (
    <button
      type="button"
      onClick={() => onCollapse?.(sumSources)}
      className="my-1 text-xs text-neutral-500 hover:text-white"
    >
      ▲ collapse to summary
    </button>
  );
})()}
```

Import `summariesOf` at the top of the file.

**Step 4: Pass graph and callbacks through the component tree**

Thread and MessageGroupComponent need `graph`, `onExpand`, and `onCollapse` as additional props. Thread takes them directly from ConversationThread and passes to MessageGroupComponent.

**Step 5: Verify expand/collapse works**

Run: `bun run dev:web`
Expected:
1. Summarize some messages → summary appears with dashed blue border and "Summary" label
2. Click "show N original messages" → original messages reappear, summary disappears
3. "collapse to summary" button appears after the last source message → click to collapse back

**Step 6: Commit**

```bash
git add clients/web/src/components/ConversationThread.tsx clients/web/src/App.tsx
git commit -m "feat(web): add summary display with expand/collapse controls"
```

---

### Task 6: Polish and final verification

**Files:**
- Possibly: `clients/web/src/components/ConversationThread.tsx`

**Step 1: Clear selection when graph changes (after summarize)**

Ensure `selectedIds` is cleared when a summarize completes. This should already happen in the `handleSummarizeClick` handler from Task 3. Verify.

**Step 2: Disable selection during streaming**

In MessageGroupComponent, don't render checkboxes when `isStreaming` is true (pass this from ConversationThread which can derive it from `state.isConnected`). Actually, this is already handled by `isSummarizing` and the fact that checkboxes are inert during streaming. For the POC, skip this — selection during streaming is harmless.

**Step 3: Format and test**

Run: `bun run format`
Run: `bun test server/summarize.test.ts packages/ai/client/__tests__/summarize.test.ts`
Expected: All tests pass, formatting clean.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: format summarization UX changes"
```
