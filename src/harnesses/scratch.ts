import { z } from "zod";
import { spawn } from "bun";
import { openRouterHarness } from "./openrouter";
import { createAgentHarness } from "./agent";
import type { ToolDefinition, HarnessEvent } from "../types";
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
} from "@opentui/core";

const bashSchema = z.object({
  command: z.string().describe("The shell command to execute"),
});

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const bashTool: ToolDefinition<typeof bashSchema, BashResult> = {
  name: "bash",
  description: "Execute a shell command. Returns stdout, stderr, and exit code.",
  schema: bashSchema,
  execute: async ({ command }, _ctx) => {
    const proc = spawn({
      cmd: ["sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const result: BashResult = { exitCode, stdout, stderr };

    let context = "";
    if (stdout) context += `stdout:\n${stdout}\n`;
    if (stderr) context += `stderr:\n${stderr}\n`;
    context += `exit code: ${exitCode}`;

    return { context, result };
  },
};

// Subagent tool
const subagentSchema = z.object({
  task: z.string().describe("The task to delegate to the subagent"),
});

interface SubagentResult {
  response: string;
  toolCalls: number;
}

const createSubagentTool = (
  availableTools: ToolDefinition[],
): ToolDefinition<typeof subagentSchema, SubagentResult> => ({
  name: "subagent",
  description: "Spawn a subagent to handle a delegated task. The subagent has access to the bash tool.",
  schema: subagentSchema,
  execute: async ({ task }, ctx) => {
    const subagent = createAgentHarness({
      harness: openRouterHarness,
      maxIterations: 3,
    });

    let response = "";
    let toolCalls = 0;

    await subagent.invoke({
      model: "nvidia/nemotron-nano-9b-v2:free",
      messages: [{ role: "user", content: task }],
      tools: availableTools,
      context: { parentId: ctx.parentId }, // Pass through the tool_call ID
      emit: (event) => {
        ctx.emit(event); // Forward to parent
        if (event.type === "text") {
          response += event.content;
        } else if (event.type === "tool_call") {
          toolCalls++;
        }
      },
    });

    return {
      context: `Subagent response: ${response}`,
      result: { response, toolCalls },
    };
  },
});

// ============================================================================
// TUI Renderer - OpenTUI-based visualization for nested agent events
// ============================================================================

interface AgentBox {
  container: BoxRenderable;
  scrollBox: ScrollBoxRenderable;
  content: TextRenderable;
  contentStr: string; // Track content as a string
  depth: number;
}

interface TuiState {
  renderer: CliRenderer;
  rootContainer: BoxRenderable;
  agentBoxes: Map<string, AgentBox>; // runId -> box
  toolCallDepths: Map<string, number>; // tool_call id -> depth
  depthCache: Map<string, number>; // runId -> depth
  currentStreamId: string | null;
  streamBuffer: string; // Accumulate streaming content
}

async function createTuiRenderer() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: false, // Stay in main screen for logs
  });

  // Root container - vertical stack
  const rootContainer = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: 1,
    gap: 1,
  });

  renderer.root.add(rootContainer);

  const state: TuiState = {
    renderer,
    rootContainer,
    agentBoxes: new Map(),
    toolCallDepths: new Map(),
    depthCache: new Map(),
    currentStreamId: null,
    streamBuffer: "",
  };

  // Calculate depth from parentId chain
  const getDepth = (event: HarnessEvent): number => {
    const { runId, parentId } = event;

    if (state.depthCache.has(runId)) {
      return state.depthCache.get(runId)!;
    }

    if (!parentId) {
      state.depthCache.set(runId, 0);
      return 0;
    }

    const parentDepth = state.toolCallDepths.get(parentId) ?? 0;
    const depth = parentDepth + 1;
    state.depthCache.set(runId, depth);
    return depth;
  };

  // Get or create an agent box for the given runId
  const getOrCreateAgentBox = (runId: string, depth: number, title?: string): AgentBox => {
    if (state.agentBoxes.has(runId)) {
      return state.agentBoxes.get(runId)!;
    }

    // Create a new box for this agent
    const container = new BoxRenderable(renderer, {
      id: `agent-${runId}`,
      border: true,
      borderStyle: depth === 0 ? "rounded" : "single",
      borderColor: depth === 0 ? "#3b82f6" : "#6b7280",
      title: title ?? `Agent (depth ${depth})`,
      titleAlignment: "left",
      flexDirection: "column",
      marginLeft: depth * 2, // Visual indentation
      width: `${100 - depth * 4}%`,
      height: 20, // Fixed height for scrolling
      flexShrink: 0,
    });

    // ScrollBox for scrolling content
    const scrollBox = new ScrollBoxRenderable(renderer, {
      id: `scroll-${runId}`,
      width: "100%",
      height: "100%",
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom", // Auto-scroll to bottom on new content
    });

    const content = new TextRenderable(renderer, {
      id: `content-${runId}`,
      content: "",
      width: "100%",
      wrapMode: "word", // Wrap long lines
    });

    scrollBox.add(content);
    container.add(scrollBox);
    state.rootContainer.add(container);

    const box: AgentBox = { container, scrollBox, content, contentStr: "", depth };
    state.agentBoxes.set(runId, box);
    return box;
  };

  // Format output for display (truncate if long)
  const formatOutput = (output: unknown): string => {
    const str = JSON.stringify(output, null, 2);
    const lines = str.split("\n");
    if (lines.length <= 6) return str;
    return lines.slice(0, 5).join("\n") + `\n... (${lines.length - 5} more lines)`;
  };

  const render = (event: HarnessEvent): void => {
    const depth = getDepth(event);
    const box = getOrCreateAgentBox(event.runId, depth);

    switch (event.type) {
      case "text": {
        // Accumulate streaming text
        if (event.id !== state.currentStreamId) {
          // New stream - flush any previous buffer
          if (state.currentStreamId && state.streamBuffer) {
            box.contentStr += state.streamBuffer + "\n";
            state.streamBuffer = "";
          }
          state.currentStreamId = event.id;
        }
        state.streamBuffer += event.content;
        // Update display with current buffer
        box.contentStr += state.streamBuffer;
        box.content.content = box.contentStr;
        state.streamBuffer = ""; // Clear since we just displayed it
        break;
      }

      case "reasoning": {
        // Show reasoning (dimmed would require styled text)
        if (event.id !== state.currentStreamId) {
          if (state.currentStreamId && state.streamBuffer) {
            box.contentStr += state.streamBuffer + "\n";
            state.streamBuffer = "";
          }
          state.currentStreamId = event.id;
          box.contentStr += "\n💭 ";
        }
        // Append reasoning content directly (like text)
        box.contentStr += event.content;
        box.content.content = box.contentStr;
        break;
      }

      case "tool_call": {
        // Flush any streaming content
        if (state.streamBuffer) {
          box.contentStr += state.streamBuffer + "\n";
          state.streamBuffer = "";
          state.currentStreamId = null;
        }

        // Record depth for child agents
        state.toolCallDepths.set(event.id, depth);

        const inputStr = typeof event.input === "string"
          ? event.input
          : JSON.stringify(event.input);

        box.contentStr += `\n🔧 ${event.name}: ${inputStr}\n`;
        box.content.content = box.contentStr;

        // Update the box title to show current tool
        box.container.title = `Agent → ${event.name}`;
        break;
      }

      case "tool_result": {
        // Flush any streaming content
        if (state.streamBuffer) {
          box.contentStr += state.streamBuffer + "\n";
          state.streamBuffer = "";
          state.currentStreamId = null;
        }

        const output = formatOutput(event.output);
        box.contentStr += `   ↳ ${output}\n`;
        box.content.content = box.contentStr;
        break;
      }

      case "error": {
        // Flush any streaming content
        if (state.streamBuffer) {
          box.contentStr += state.streamBuffer + "\n";
          state.streamBuffer = "";
          state.currentStreamId = null;
        }

        box.contentStr += `\n❌ Error: ${event.error.message}\n`;
        box.content.content = box.contentStr;
        box.container.borderColor = "#ef4444"; // Red border on error
        break;
      }
    }
  };

  const finish = (): void => {
    // Flush any remaining buffer
    if (state.streamBuffer && state.currentStreamId) {
      // Find the box for the current stream
      for (const [, box] of state.agentBoxes) {
        box.contentStr += state.streamBuffer;
        box.content.content = box.contentStr;
        break;
      }
      state.streamBuffer = "";
      state.currentStreamId = null;
    }
  };

  const destroy = (): void => {
    state.renderer.destroy();
  };

  return { render, finish, destroy, renderer: state.renderer };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Subagent only gets bash (no subagent to prevent infinite recursion)
  const subagentTool = createSubagentTool([bashTool]);

  const agentHarness = createAgentHarness({
    harness: openRouterHarness,
    maxIterations: 5,
  });

  const tui = await createTuiRenderer();

  try {
    await agentHarness.invoke({
      model: "nvidia/nemotron-nano-9b-v2:free",
      messages: [
        {
          role: "user",
          content: "Use the subagent to find out what directory we're in and list its contents.",
        },
      ],
      tools: [bashTool, subagentTool],
      emit: tui.render,
    });

    tui.finish();

    // Keep the TUI open for a moment to see the final state
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } finally {
    tui.destroy();
  }
}

main().catch(console.error);
