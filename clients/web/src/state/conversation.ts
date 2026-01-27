import { v4 as uuidv4 } from "uuid";
import type { ContentBlock, ConversationState, MessageNode, ServerEvent, ToolCall } from "../types";

export function createInitialState(): ConversationState {
  return {
    sessionId: null,
    messages: [],
    isStreaming: false,
    pendingRelay: null,
    grantedTools: new Set(),
  };
}

export function addUserMessage(state: ConversationState, content: string): ConversationState {
  const userNode: MessageNode = {
    id: uuidv4(),
    agentId: "user",
    role: "user",
    contentBlocks: [{ type: "text", content }],
    children: [],
  };
  return {
    ...state,
    messages: [...state.messages, userNode],
  };
}

export function addErrorMessage(state: ConversationState, error: string): ConversationState {
  const errorNode: MessageNode = {
    id: uuidv4(),
    agentId: "system",
    role: "assistant",
    contentBlocks: [{ type: "text", content: `Error: ${error}` }],
    children: [],
  };
  return {
    ...state,
    messages: [...state.messages, errorNode],
  };
}

// Helper to check if a node contains a tool call with given id
function hasToolCall(node: MessageNode, toolCallId: string): boolean {
  return node.contentBlocks.some(
    (block) => block.type === "tool_call" && block.toolCall.id === toolCallId,
  );
}

export function findOrCreateAgentNode(
  messages: MessageNode[],
  runId: string,
  parentId?: string,
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
    contentBlocks: [],
    children: [],
  };

  // If parentId, find parent and add as child
  if (parentId) {
    let parentFound = false;
    const addChild = (nodes: MessageNode[]): MessageNode[] =>
      nodes.map((node) => {
        if (node.id === parentId || hasToolCall(node, parentId)) {
          parentFound = true;
          return { ...node, children: [...node.children, newNode] };
        }
        return { ...node, children: addChild(node.children) };
      });
    const updatedMessages = addChild(messages);
    if (parentFound) {
      return { messages: updatedMessages, node: newNode };
    }
    // Parent not found — fall back to root to avoid dropping the node
  }

  // No parent (or parent not found), add to root
  return { messages: [...messages, newNode], node: newNode };
}

export function updateAgentNode(
  messages: MessageNode[],
  runId: string,
  updater: (node: MessageNode) => MessageNode,
): MessageNode[] {
  return messages.map((node) => {
    if (node.id === runId) return updater(node);
    return { ...node, children: updateAgentNode(node.children, runId, updater) };
  });
}

// Helper to append to last block if same type, or create new block
function appendOrCreateBlock(
  blocks: ContentBlock[],
  blockType: "text" | "reasoning",
  content: string,
): ContentBlock[] {
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock && lastBlock.type === blockType) {
    // Append to existing block
    return [...blocks.slice(0, -1), { ...lastBlock, content: lastBlock.content + content }];
  }
  // Create new block
  return [...blocks, { type: blockType, content }];
}

export function handleEvent(state: ConversationState, event: ServerEvent): ConversationState {
  // Handle connected event first (no runId)
  if (event.type === "connected") {
    return {
      ...state,
      sessionId: event.sessionId,
    };
  }

  const runId = event.runId;
  const parentId = "parentId" in event ? event.parentId : undefined;

  // Guard against missing runId
  if (!runId) {
    console.warn("Event missing runId:", event);
    return state;
  }

  switch (event.type) {
    case "text": {
      const { messages } = findOrCreateAgentNode(state.messages, runId, parentId);
      return {
        ...state,
        messages: updateAgentNode(messages, runId, (node) => ({
          ...node,
          contentBlocks: appendOrCreateBlock(node.contentBlocks, "text", event.content),
        })),
      };
    }

    case "reasoning": {
      const { messages } = findOrCreateAgentNode(state.messages, runId, parentId);
      return {
        ...state,
        messages: updateAgentNode(messages, runId, (node) => ({
          ...node,
          contentBlocks: appendOrCreateBlock(node.contentBlocks, "reasoning", event.content),
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
          contentBlocks: [...node.contentBlocks, { type: "tool_call", toolCall }],
        })),
      };
    }

    case "tool_result": {
      return {
        ...state,
        messages: updateAgentNode(state.messages, runId, (node) => ({
          ...node,
          contentBlocks: node.contentBlocks.map((block) =>
            block.type === "tool_call" && block.toolCall.id === event.id
              ? { ...block, toolCall: { ...block.toolCall, output: event.output } }
              : block,
          ),
        })),
      };
    }

    case "relay": {
      return {
        ...state,
        pendingRelay: {
          relayId: event.id,
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
          contentBlocks: appendOrCreateBlock(
            node.contentBlocks,
            "text",
            `\n\nError: ${event.message}`,
          ),
        })),
      };
    }

    default:
      return state;
  }
}
