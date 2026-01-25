import { v4 as uuidv4 } from "uuid";
import type { ConversationState, MessageNode, ServerEvent, ToolCall } from "../types";

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
    id: uuidv4(),
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

export function addErrorMessage(state: ConversationState, error: string): ConversationState {
  const errorNode: MessageNode = {
    id: uuidv4(),
    agentId: "system",
    role: "assistant",
    content: `Error: ${error}`,
    reasoning: [],
    toolCalls: [],
    children: [],
  };
  return {
    ...state,
    messages: [...state.messages, errorNode],
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
