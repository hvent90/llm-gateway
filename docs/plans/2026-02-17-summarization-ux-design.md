# Web Client Summarization UX Design

## Problem

The server `/summarize` endpoint and client `summarizeFromEvents` helper exist, but the web client has no UI for selecting messages and triggering summarization.

## Approach

Add message selection (checkboxes on hover), an inline "Summarize" action, summary display with expand/collapse, all within the existing ConversationThread component. Selection state is local to the thread; graph mutations flow through App.tsx callbacks.

## Selection

- Each `MessageGroupComponent` gets a checkbox on hover (left side)
- Checkboxes stay visible once any message is selected
- `selectedIds: Set<string>` is local state in `ConversationThread`
- Shift-click selects contiguous range between last-clicked and current

## Summarize Action

- Inline bar after the last selected message group: "Summarize N messages" button
- Calls `onSummarize(sourceIds, messages)` callback prop
- Thread extracts message content via `deriveMessageContent()` before calling
- Selection clears after triggering

## App.tsx Flow

1. `onSummarize` handler streams `POST /summarize` via SSE
2. Collects text events into summary string
3. Calls `summarizeFromEvents(graph, active, sourceIds, summaryText)`
4. Updates `ConversationState`

## Summary Display

- Distinct styling: dashed left border, "Summary" label
- Expand/collapse toggle: "Show N original messages" / "Collapse to summary"
- Expand calls `operations.expand()`, collapse calls `operations.collapse()`
- Summary detected via `sourcesOf(graph, nodeId)` returning non-empty

## New Props on ConversationThread

```typescript
onSummarize: (sourceIds: string[], messages: Message[]) => void;
onExpand: (nodeId: string) => void;
onCollapse: (nodeIds: string[]) => void;
```

## Not in Scope

- Keyboard shortcuts for selection
- Selecting individual blocks within a message
- Summarize while streaming
- Multi-model summary
