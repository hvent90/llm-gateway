# Web Client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a web-based chat client for validating the LLM Gateway harness and API.

**Architecture:** React SPA with Base UI components, Tailwind styling, and Effect/Rx for state management. Communicates with gateway server via SSE streaming at `/chat` endpoint.

**Tech Stack:** Bun, Vite, React, Base UI, Tailwind CSS, Effect, @effect/rx

---

## Task 1: Project Scaffolding

**Files:**
- Create: `clients/web/index.html`
- Create: `clients/web/vite.config.ts`
- Create: `clients/web/tailwind.config.ts`
- Create: `clients/web/src/main.tsx`
- Create: `clients/web/src/App.tsx`
- Create: `clients/web/postcss.config.js`
- Create: `clients/web/src/index.css`
- Modify: `package.json`

**Step 1: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LLM Gateway</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 2: Create vite.config.ts**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "clients/web",
  server: {
    proxy: {
      "/chat": "http://localhost:3000",
    },
  },
});
```

**Step 3: Create tailwind.config.ts**

```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}", "./index.html"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
```

**Step 4: Create postcss.config.js**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

**Step 5: Create src/index.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**Step 6: Create src/main.tsx**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

**Step 7: Create src/App.tsx**

```tsx
export default function App() {
  return (
    <div className="flex h-screen flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-3">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 p-4">
        <p>Web client scaffolding complete.</p>
      </main>
    </div>
  );
}
```

**Step 8: Install dependencies**

Run:
```bash
cd clients/web && bun add react react-dom @vitejs/plugin-react vite tailwindcss postcss autoprefixer
cd clients/web && bun add -d @types/react @types/react-dom
```

**Step 9: Add scripts to root package.json**

Add to `scripts`:
```json
"web": "bunx vite --config clients/web/vite.config.ts",
"web:build": "bunx vite build --config clients/web/vite.config.ts"
```

**Step 10: Verify scaffolding works**

Run: `bun run web`
Expected: Browser opens, shows "LLM Gateway" header and "Web client scaffolding complete."

**Step 11: Commit**

```bash
git add clients/web package.json
git commit -m "feat(web): scaffold vite + react + tailwind project"
```

---

## Task 2: Types and State Structure

**Files:**
- Create: `clients/web/src/types.ts`
- Create: `clients/web/src/state/conversation.ts`

**Step 1: Create types.ts**

```ts
// Message types (matching server's packages/ai/types.ts)
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// Server event types
export type ServerEvent =
  | { type: "text"; runId: string; id: string; parentId?: string; content: string }
  | { type: "reasoning"; runId: string; id: string; parentId?: string; content: string }
  | { type: "tool_call"; runId: string; id: string; parentId?: string; name: string; input: unknown }
  | { type: "tool_result"; runId: string; id: string; parentId?: string; name: string; output: unknown }
  | { type: "error"; runId: string; parentId?: string; message: string }
  | {
      type: "permission_required";
      runId: string;
      id: string;
      parentId?: string;
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    };

// Tool call display
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
}

// Message node for tree display
export interface MessageNode {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string[];
  toolCalls: ToolCall[];
  children: MessageNode[];
}

// Permission request
export interface PermissionRequest {
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

// Conversation state
export interface ConversationState {
  messages: MessageNode[];
  isStreaming: boolean;
  pendingPermission: PermissionRequest | null;
  grantedTools: Set<string>;
}
```

**Step 2: Create state/conversation.ts**

```ts
import type { ConversationState, MessageNode, PermissionRequest, ServerEvent, ToolCall } from "../types";

export function createInitialState(): ConversationState {
  return {
    messages: [],
    isStreaming: false,
    pendingPermission: null,
    grantedTools: new Set(),
  };
}

export function addUserMessage(state: ConversationState, content: string): ConversationState {
  const userNode: MessageNode = {
    id: crypto.randomUUID(),
    agentId: "user",
    role: "user",
    content,
    reasoning: [],
    toolCalls: [],
    children: [],
  };
  return {
    ...state,
    messages: [...state.messages, userNode],
  };
}

export function findOrCreateAgentNode(
  messages: MessageNode[],
  runId: string,
  parentId?: string
): { messages: MessageNode[]; node: MessageNode } {
  // Find existing node with this runId
  const findNode = (nodes: MessageNode[]): MessageNode | null => {
    for (const node of nodes) {
      if (node.id === runId) return node;
      const found = findNode(node.children);
      if (found) return found;
    }
    return null;
  };

  const existing = findNode(messages);
  if (existing) return { messages, node: existing };

  // Create new node
  const newNode: MessageNode = {
    id: runId,
    agentId: runId,
    role: "assistant",
    content: "",
    reasoning: [],
    toolCalls: [],
    children: [],
  };

  // If parentId, find parent and add as child
  if (parentId) {
    const addChild = (nodes: MessageNode[]): MessageNode[] =>
      nodes.map((node) => {
        if (node.id === parentId || node.toolCalls.some((tc) => tc.id === parentId)) {
          return { ...node, children: [...node.children, newNode] };
        }
        return { ...node, children: addChild(node.children) };
      });
    return { messages: addChild(messages), node: newNode };
  }

  // No parent, add to root
  return { messages: [...messages, newNode], node: newNode };
}

export function updateAgentNode(
  messages: MessageNode[],
  runId: string,
  updater: (node: MessageNode) => MessageNode
): MessageNode[] {
  return messages.map((node) => {
    if (node.id === runId) return updater(node);
    return { ...node, children: updateAgentNode(node.children, runId, updater) };
  });
}

export function handleEvent(state: ConversationState, event: ServerEvent): ConversationState {
  const runId = event.runId;
  const parentId = "parentId" in event ? event.parentId : undefined;

  switch (event.type) {
    case "text": {
      const { messages } = findOrCreateAgentNode(state.messages, runId, parentId);
      return {
        ...state,
        messages: updateAgentNode(messages, runId, (node) => ({
          ...node,
          content: node.content + event.content,
        })),
      };
    }

    case "reasoning": {
      const { messages } = findOrCreateAgentNode(state.messages, runId, parentId);
      return {
        ...state,
        messages: updateAgentNode(messages, runId, (node) => ({
          ...node,
          reasoning: [...node.reasoning, event.content],
        })),
      };
    }

    case "tool_call": {
      const { messages } = findOrCreateAgentNode(state.messages, runId, parentId);
      const toolCall: ToolCall = { id: event.id, name: event.name, input: event.input };
      return {
        ...state,
        messages: updateAgentNode(messages, runId, (node) => ({
          ...node,
          toolCalls: [...node.toolCalls, toolCall],
        })),
      };
    }

    case "tool_result": {
      return {
        ...state,
        messages: updateAgentNode(state.messages, runId, (node) => ({
          ...node,
          toolCalls: node.toolCalls.map((tc) =>
            tc.id === event.id ? { ...tc, output: event.output } : tc
          ),
        })),
      };
    }

    case "permission_required": {
      return {
        ...state,
        pendingPermission: {
          toolCallId: event.toolCallId,
          tool: event.tool,
          params: event.params,
        },
      };
    }

    case "error": {
      const { messages } = findOrCreateAgentNode(state.messages, runId, parentId);
      return {
        ...state,
        messages: updateAgentNode(messages, runId, (node) => ({
          ...node,
          content: node.content + `\n\nError: ${event.message}`,
        })),
      };
    }

    default:
      return state;
  }
}
```

**Step 3: Commit**

```bash
git add clients/web/src/types.ts clients/web/src/state/conversation.ts
git commit -m "feat(web): add types and conversation state management"
```

---

## Task 3: SSE Service

**Files:**
- Create: `clients/web/src/services/chat.ts`

**Step 1: Install Effect dependencies**

Run:
```bash
cd clients/web && bun add effect @effect/platform
```

**Step 2: Create services/chat.ts**

```ts
import type { Message, ServerEvent } from "../types";

export interface ChatRequest {
  model: string;
  messages: Message[];
  permissions?: string[];
}

export async function* streamChat(
  request: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<ServerEvent> {
  const response = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      permissions: request.permissions
        ? { allowlist: request.permissions.map((tool) => ({ tool })) }
        : undefined,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const lines = buffer.split("\n");
      buffer = "";

      let eventType = "";
      let data = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("data: ")) {
          data = line.slice(6);
        } else if (line === "" && data) {
          try {
            const event = JSON.parse(data) as ServerEvent;
            yield event;
          } catch {
            // Skip invalid JSON
          }
          eventType = "";
          data = "";
        } else if (line !== "") {
          // Incomplete line, keep in buffer
          buffer = line;
        }
      }

      // Keep partial event in buffer
      if (eventType || data) {
        if (eventType) buffer += `event: ${eventType}\n`;
        if (data) buffer += `data: ${data}\n`;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

**Step 3: Commit**

```bash
git add clients/web/src/services/chat.ts
git commit -m "feat(web): add SSE streaming chat service"
```

---

## Task 4: Base UI Setup and Input Component

**Files:**
- Create: `clients/web/src/components/InputArea.tsx`
- Modify: `clients/web/src/App.tsx`

**Step 1: Install Base UI**

Run:
```bash
cd clients/web && bun add @base-ui-components/react
```

**Step 2: Create components/InputArea.tsx**

```tsx
import { Input } from "@base-ui-components/react/input";
import { useState, useRef, useEffect } from "react";

interface InputAreaProps {
  onSubmit: (content: string) => void;
  disabled: boolean;
}

export function InputArea({ onSubmit, disabled }: InputAreaProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      onSubmit(trimmed);
      setValue("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex gap-2 border-t border-gray-700 p-4">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={disabled ? "Waiting for response..." : "Type your message..."}
        className="flex-1 rounded border border-gray-600 bg-gray-800 px-3 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
      />
      <button
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
        className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600"
      >
        Send
      </button>
    </div>
  );
}
```

**Step 3: Update App.tsx to use InputArea**

```tsx
import { useState } from "react";
import { InputArea } from "./components/InputArea";

export default function App() {
  const [isStreaming, setIsStreaming] = useState(false);

  const handleSubmit = (content: string) => {
    console.log("Submit:", content);
    // TODO: integrate with chat service
  };

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-3">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 overflow-auto p-4">
        <p className="text-gray-400">Start a conversation below.</p>
      </main>
      <InputArea onSubmit={handleSubmit} disabled={isStreaming} />
    </div>
  );
}
```

**Step 4: Verify input works**

Run: `bun run web`
Expected: Input field renders, typing and pressing Enter logs to console.

**Step 5: Commit**

```bash
git add clients/web/src/components/InputArea.tsx clients/web/src/App.tsx
git commit -m "feat(web): add input area with Base UI"
```

---

## Task 5: Message Display Components

**Files:**
- Create: `clients/web/src/components/MessageNode.tsx`
- Create: `clients/web/src/components/ConversationThread.tsx`

**Step 1: Create components/MessageNode.tsx**

```tsx
import type { MessageNode as MessageNodeType, ToolCall } from "../types";

interface MessageNodeProps {
  node: MessageNodeType;
  depth?: number;
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCall }) {
  const inputStr = typeof toolCall.input === "string"
    ? toolCall.input
    : JSON.stringify(toolCall.input, null, 2);

  const outputStr = toolCall.output !== undefined
    ? typeof toolCall.output === "string"
      ? toolCall.output
      : JSON.stringify(toolCall.output, null, 2)
    : null;

  return (
    <div className="my-2 rounded border border-gray-700 bg-gray-800 p-2 text-sm">
      <div className="font-mono text-yellow-400">
        🔧 {toolCall.name}
      </div>
      <pre className="mt-1 overflow-x-auto text-gray-400">{inputStr}</pre>
      {outputStr && (
        <div className="mt-2 border-t border-gray-700 pt-2">
          <span className="text-gray-500">↳ </span>
          <pre className="inline overflow-x-auto text-gray-300">{outputStr}</pre>
        </div>
      )}
    </div>
  );
}

export function MessageNode({ node, depth = 0 }: MessageNodeProps) {
  const isUser = node.role === "user";
  const indent = depth > 0 ? `ml-${Math.min(depth * 4, 16)}` : "";

  return (
    <div className={`${indent} mb-4`}>
      {/* Header */}
      <div className={`font-medium ${isUser ? "text-blue-400" : "text-green-400"}`}>
        {isUser ? "You" : `Agent-${node.agentId.slice(0, 8)}`}
      </div>

      {/* Reasoning */}
      {node.reasoning.length > 0 && (
        <div className="mt-1 text-sm italic text-gray-500">
          💭 {node.reasoning.join("")}
        </div>
      )}

      {/* Tool calls */}
      {node.toolCalls.map((tc) => (
        <ToolCallBlock key={tc.id} toolCall={tc} />
      ))}

      {/* Content */}
      {node.content && (
        <div className="mt-1 whitespace-pre-wrap text-gray-200">
          {node.content}
        </div>
      )}

      {/* Children (subagents) */}
      {node.children.length > 0 && (
        <div className="mt-2 border-l-2 border-gray-700 pl-4">
          {node.children.map((child) => (
            <MessageNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Create components/ConversationThread.tsx**

```tsx
import { useRef, useEffect } from "react";
import type { MessageNode as MessageNodeType } from "../types";
import { MessageNode } from "./MessageNode";

interface ConversationThreadProps {
  messages: MessageNodeType[];
}

export function ConversationThread({ messages }: ConversationThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        Start a conversation below.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((node) => (
        <MessageNode key={node.id} node={node} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add clients/web/src/components/MessageNode.tsx clients/web/src/components/ConversationThread.tsx
git commit -m "feat(web): add message display components with nested agent support"
```

---

## Task 6: Permission Prompt Component

**Files:**
- Create: `clients/web/src/components/PermissionPrompt.tsx`

**Step 1: Create components/PermissionPrompt.tsx**

```tsx
import type { PermissionRequest } from "../types";

interface PermissionPromptProps {
  request: PermissionRequest;
  onAllow: () => void;
  onAllowAll: () => void;
  onDeny: () => void;
}

export function PermissionPrompt({ request, onAllow, onAllowAll, onDeny }: PermissionPromptProps) {
  const paramsStr = JSON.stringify(request.params, null, 2);

  return (
    <div className="my-4 rounded border border-yellow-600 bg-yellow-900/20 p-4">
      <div className="mb-2 font-medium text-yellow-400">
        ⚠️ Permission Required
      </div>
      <div className="mb-2 text-sm text-gray-300">
        Tool: <span className="font-mono text-yellow-300">{request.tool}</span>
      </div>
      <pre className="mb-4 overflow-x-auto rounded bg-gray-800 p-2 text-sm text-gray-400">
        {paramsStr}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={onAllow}
          className="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
        >
          Allow
        </button>
        <button
          onClick={onAllowAll}
          className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
        >
          Allow All
        </button>
        <button
          onClick={onDeny}
          className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add clients/web/src/components/PermissionPrompt.tsx
git commit -m "feat(web): add permission prompt component"
```

---

## Task 7: Wire Everything Together

**Files:**
- Modify: `clients/web/src/App.tsx`

**Step 1: Update App.tsx with full integration**

```tsx
import { useState, useCallback } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { streamChat } from "./services/chat";
import {
  createInitialState,
  addUserMessage,
  handleEvent,
} from "./state/conversation";
import type { ConversationState, Message } from "./types";

const MODEL = "nvidia/nemotron-nano-9b-v2:free";

export default function App() {
  const [state, setState] = useState<ConversationState>(createInitialState);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const handleSubmit = useCallback(async (content: string) => {
    // Add user message
    setState((s) => ({ ...addUserMessage(s, content), isStreaming: true }));

    // Build messages array for API
    const messages: Message[] = [];
    const buildMessages = (nodes: typeof state.messages) => {
      for (const node of nodes) {
        messages.push({ role: node.role, content: node.content });
        buildMessages(node.children);
      }
    };
    buildMessages(state.messages);
    messages.push({ role: "user", content });

    // Create abort controller
    const controller = new AbortController();
    setAbortController(controller);

    try {
      const stream = streamChat(
        {
          model: MODEL,
          messages,
          permissions: Array.from(state.grantedTools),
        },
        controller.signal
      );

      for await (const event of stream) {
        setState((s) => handleEvent(s, event));
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Stream error:", error);
      }
    } finally {
      setState((s) => ({ ...s, isStreaming: false }));
      setAbortController(null);
    }
  }, [state.messages, state.grantedTools]);

  const handleAllow = useCallback(() => {
    // TODO: Send allow response to server
    setState((s) => ({ ...s, pendingPermission: null }));
  }, []);

  const handleAllowAll = useCallback(() => {
    if (state.pendingPermission) {
      const tool = state.pendingPermission.tool;
      setState((s) => ({
        ...s,
        pendingPermission: null,
        grantedTools: new Set([...s.grantedTools, tool]),
      }));
    }
  }, [state.pendingPermission]);

  const handleDeny = useCallback(() => {
    // TODO: Send deny response to server
    setState((s) => ({ ...s, pendingPermission: null }));
    abortController?.abort();
  }, [abortController]);

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-3">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 overflow-auto p-4">
        <ConversationThread messages={state.messages} />
        {state.pendingPermission && (
          <PermissionPrompt
            request={state.pendingPermission}
            onAllow={handleAllow}
            onAllowAll={handleAllowAll}
            onDeny={handleDeny}
          />
        )}
      </main>
      <InputArea
        onSubmit={handleSubmit}
        disabled={state.isStreaming || state.pendingPermission !== null}
      />
    </div>
  );
}
```

**Step 2: Verify full flow works**

Run:
```bash
# Terminal 1
bun run dev

# Terminal 2
bun run web
```

Expected: Can send message, see streaming response with text/reasoning/tool calls rendered.

**Step 3: Commit**

```bash
git add clients/web/src/App.tsx
git commit -m "feat(web): integrate all components into working chat client"
```

---

## Task 8: Manual Validation

**Files:** None (testing only)

**Step 1: Start server and client**

Run in separate terminals:
```bash
bun run dev
bun run web
```

**Step 2: Validate streaming text**

Send: "Hello, how are you?"
Expected: Text appears incrementally as it streams.

**Step 3: Validate tool calls**

Send: "List the files in the current directory"
Expected:
- Tool call block appears with 🔧 bash
- Tool result appears with ↳ output
- Final text response appears

**Step 4: Validate reasoning display**

Send a question that triggers reasoning (model-dependent).
Expected: Reasoning appears dimmed with 💭 prefix.

**Step 5: Validate input disabled during streaming**

While streaming, try to type.
Expected: Input is disabled, shows "Waiting for response..."

**Step 6: Commit validation complete**

```bash
git commit --allow-empty -m "chore(web): manual validation complete"
```

---

## Summary

| Task | Description |
|------|-------------|
| 1 | Project scaffolding (Vite, React, Tailwind) |
| 2 | Types and state structure |
| 3 | SSE streaming service |
| 4 | Base UI input component |
| 5 | Message display with nested agents |
| 6 | Permission prompt component |
| 7 | Full integration |
| 8 | Manual validation |
