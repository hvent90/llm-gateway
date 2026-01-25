import { v7 } from "uuid";
import { z } from "zod";
import { OpenRouter, tool } from "@openrouter/sdk";
import type {
  Message,
  ToolCall,
  HarnessEvent,
  Permissions,
  ToolExecutionResult,
} from "../packages/ai/types";

// ============ Utilities ============

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class AsyncQueue<T> {
  private queue: T[] = [];
  private waiting: Array<(value: T) => void> = [];

  push(value: T) {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(value);
    } else {
      this.queue.push(value);
    }
  }

  async pop(): Promise<T> {
    const value = this.queue.shift();
    if (value !== undefined) {
      return value;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  get length() {
    return this.queue.length;
  }
}

// ============ Types ============

export interface InvokeParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  context?: {
    runId?: string;
    parentId?: string;
  };
  permissions?: Permissions;
}

export interface ToolContext {
  parentId?: string;
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  name: string;
  description: string;
  schema: TSchema;
  execute?: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolExecutionResult<TResult>>;
}

export interface PermissionRequest {
  type: "permission_required";
  runId: string;
  id: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
  parentId?: string;
  respond: (approved: boolean, reason?: string) => void;
}

export type HarnessEventWithPermission = HarnessEvent | PermissionRequest;

// Event with agent ID attached (output of multiplexer)
export type MultiplexedEvent<T> = {
  agentId: string;
  event: T;
};

// ============ Harness (unchanged) ============

function convertMessages(messages: Message[]) {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      return { role: "assistant" as const, content: msg.content ?? "" };
    }
    if (msg.role === "tool") {
      return {
        type: "function_call_output" as const,
        callId: msg.tool_call_id,
        output: msg.content,
      };
    }
    return msg;
  });
}

function convertTools(tools: ToolDefinition[]) {
  return tools.map((t) =>
    tool({
      name: t.name,
      description: t.description,
      inputSchema: t.schema as z.ZodObject<z.ZodRawShape>,
      execute: false,
    }),
  );
}

function createHarness(apiKey?: string) {
  const client = new OpenRouter({
    apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
  });

  return {
    async *invoke({ context, ...params }: InvokeParams): AsyncIterable<HarnessEventWithPermission> {
      const runId = context?.runId ?? v7();
      const parentId = context?.parentId;
      const tools = params.tools ? convertTools(params.tools) : undefined;

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      // Mutable messages array for the loop
      const messages = [...params.messages];

      while (true) {
        const input = convertMessages(messages);
        const reasoningId = v7();
        const textId = v7();

        const result = client.callModel({
          model: params.model,
          input,
          ...(tools && { tools }),
        } as Parameters<typeof client.callModel>[0]);

        const toolCalls: ToolCall[] = [];
        let assistantText = "";

        try {
          for await (const event of result.getFullResponsesStream()) {
            if (event.type === "response.output_text.delta") {
              yield tag({ type: "text", runId, id: textId, content: event.delta });
              assistantText += event.delta;
            } else if (event.type === "response.reasoning_text.delta") {
              yield tag({ type: "reasoning", runId, id: reasoningId, content: event.delta });
            } else if (event.type === "response.function_call_arguments.done") {
              const args = JSON.parse(event.arguments);
              toolCalls.push({ id: event.itemId, name: event.name, arguments: args });
            } else if (event.type === "error") {
              yield tag({
                type: "error",
                runId,
                error: new Error(event.message ?? "Unknown error"),
              });
              return;
            }
          }
        } catch (error) {
          yield tag({
            type: "error",
            runId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
          return;
        }

        // No tool calls - we're done
        if (toolCalls.length === 0) {
          return;
        }

        // Add assistant message with tool calls to history
        messages.push({ role: "assistant", content: assistantText || null, tool_calls: toolCalls });

        // Process each tool call
        for (const tc of toolCalls) {
          const toolDef = params.tools?.find((t) => t.name === tc.name);
          const args = (tc.arguments ?? {}) as Record<string, unknown>;

          const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
          if (denial) {
            const output = { status: "denied", reason: denial.reason };
            yield tag({ type: "tool_result", runId, id: tc.id, name: tc.name, output });
            messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
            continue;
          }

          const { promise, resolve } = deferred<{ approved: boolean; reason?: string }>();
          yield tag({
            type: "permission_required",
            runId,
            id: v7(),
            toolCallId: tc.id,
            tool: tc.name,
            params: args,
            respond: (approved, reason) => resolve({ approved, reason }),
          });

          const decision = await promise;

          if (!decision.approved) {
            const output = { status: "denied", reason: decision.reason };
            yield tag({ type: "tool_result", runId, id: tc.id, name: tc.name, output });
            messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
            continue;
          }

          yield tag({ type: "tool_call", runId, name: tc.name, id: tc.id, input: args });

          if (!toolDef?.execute) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: "Tool not implemented" });
            continue;
          }

          const toolCtx: ToolContext = { parentId: tc.id };

          try {
            const { context: toolContext, result: toolResult } = await toolDef.execute(
              tc.arguments,
              toolCtx,
            );
            const output = { context: toolContext, result: toolResult };
            yield tag({ type: "tool_result", runId, name: tc.name, id: tc.id, output });
            messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            yield tag({
              type: "error",
              runId,
              error: error instanceof Error ? error : new Error(errorMsg),
            });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ error: errorMsg }),
            });
          }
        }

        // Loop continues - will call LLM again with tool results
      }
    },
  };
}

// ============ Multiplexer ============

class AgentMultiplexer<T> {
  private agents = new Map<
    string,
    {
      iterator: AsyncIterator<T>;
      paused: boolean;
      pending: Promise<{ agentId: string; result: IteratorResult<T> }> | null;
    }
  >();

  private signal = new AsyncQueue<void>();

  register(agentId: string, iterable: AsyncIterable<T>) {
    const iterator = iterable[Symbol.asyncIterator]();
    this.agents.set(agentId, { iterator, paused: false, pending: null });
    this.pull(agentId);
    this.signal.push(); // Wake up consumer
  }

  unregister(agentId: string) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.iterator.return?.();
      this.agents.delete(agentId);
    }
  }

  pause(agentId: string) {
    const agent = this.agents.get(agentId);
    if (agent) agent.paused = true;
  }

  resume(agentId: string) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.paused = false;
      if (!agent.pending) this.pull(agentId);
      this.signal.push(); // Wake up consumer
    }
  }

  private pull(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.paused || agent.pending) return;

    agent.pending = agent.iterator.next().then((result) => ({ agentId, result }));
  }

  private hasActiveAgents(): boolean {
    for (const [, agent] of this.agents) {
      if (!agent.paused || agent.pending) return true;
    }
    return this.agents.size > 0;
  }

  async *events(): AsyncIterable<MultiplexedEvent<T>> {
    while (this.hasActiveAgents()) {
      // Collect non-paused pending promises
      const racing: Array<Promise<{ agentId: string; result: IteratorResult<T> }>> = [];

      for (const [agentId, agent] of this.agents) {
        if (agent.pending && !agent.paused) {
          racing.push(agent.pending);
        }
      }

      if (racing.length === 0) {
        // All paused or no pending—wait for signal
        await this.signal.pop();
        continue;
      }

      // Race all active agents
      const { agentId, result } = await Promise.race(racing);
      const agent = this.agents.get(agentId);

      if (!agent) continue; // Agent was removed while racing

      agent.pending = null;

      if (result.done) {
        this.agents.delete(agentId);
        continue;
      }

      yield { agentId, event: result.value };

      // Keep pulling if not paused
      if (!agent.paused) this.pull(agentId);
    }
  }
}

// ============ Orchestrator ============

export interface PendingPermission {
  agentId: string;
  respond: (approved: boolean, reason?: string) => void;
}

export class AgentOrchestrator {
  private harness = createHarness();
  private mux = new AgentMultiplexer<HarnessEventWithPermission>();
  private pendingPermissions = new Map<string, PendingPermission>();

  /**
   * Spawn a new agent. Returns the agent ID.
   */
  spawn(params: InvokeParams): string {
    const agentId = v7();
    const stream = this.harness.invoke(params);
    this.mux.register(agentId, stream);
    return agentId;
  }

  /**
   * Kill an agent by ID.
   */
  kill(agentId: string) {
    this.mux.unregister(agentId);
    // Clean up any pending permissions for this agent
    for (const [toolCallId, pending] of this.pendingPermissions) {
      if (pending.agentId === agentId) {
        this.pendingPermissions.delete(toolCallId);
      }
    }
  }

  /**
   * Resolve a pending permission request.
   */
  resolvePermission(toolCallId: string, approved: boolean, reason?: string) {
    const pending = this.pendingPermissions.get(toolCallId);
    if (!pending) return false;

    pending.respond(approved, reason);
    this.mux.resume(pending.agentId);
    this.pendingPermissions.delete(toolCallId);
    return true;
  }

  /**
   * Stream all events from all agents.
   * Permission events have `respond` stripped—use `resolvePermission` instead.
   */
  async *events(): AsyncIterable<MultiplexedEvent<HarnessEvent>> {
    for await (const { agentId, event } of this.mux.events()) {
      if (event.type === "permission_required") {
        // Pause this agent until permission resolved
        this.mux.pause(agentId);

        // Stash the responder
        this.pendingPermissions.set(event.toolCallId, {
          agentId,
          respond: event.respond,
        });

        // Yield event without the respond callback
        const { respond, ...forConsumer } = event;
        yield { agentId, event: forConsumer as HarnessEvent };
      } else {
        yield { agentId, event };
      }
    }
  }
}

// ============ REPL with Main Agent + Subagents ============

import * as readline from "readline";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const shellSchema = z.object({
  command: z.string().describe("The shell command to execute"),
});

const shellTool: ToolDefinition<typeof shellSchema> = {
  name: "shell",
  description: "Execute a shell command and return the output",
  schema: shellSchema,
  execute: async (input) => {
    try {
      const { stdout, stderr } = await execAsync(input.command, { timeout: 30000 });
      return {
        context: `Executed: ${input.command}`,
        result: { stdout, stderr, exitCode: 0 },
      };
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string; message?: string; code?: number };
      return {
        context: `Executed: ${input.command}`,
        result: {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? e.message ?? "",
          exitCode: e.code ?? 1,
        },
      };
    }
  },
};

const subagentSchema = z.object({
  task: z.string().describe("The task for the subagent to accomplish using shell commands"),
});

function createSpawnSubagentTool(
  orchestrator: AgentOrchestrator,
): ToolDefinition<typeof subagentSchema> {
  return {
    name: "spawn_subagent",
    description:
      "Spawn a subagent that can execute shell commands. Use this to delegate tasks that require shell access.",
    schema: subagentSchema,
    execute: async (input, ctx) => {
      const subagentId = orchestrator.spawn({
        model: "nvidia/nemotron-nano-9b-v2:free",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant with shell access. Execute commands to accomplish the user's task. Be concise.",
          },
          { role: "user", content: input.task },
        ],
        tools: [shellTool],
        context: { parentId: ctx.parentId },
      });

      return {
        context: `Spawned subagent ${subagentId} for task: ${input.task}`,
        result: { subagentId, status: "spawned" },
      };
    },
  };
}

async function repl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () =>
    new Promise<string>((resolve) => {
      rl.question("\n> ", resolve);
    });

  console.log("Agent REPL - Main agent can spawn subagents with bash access");
  console.log("Type 'exit' to quit\n");

  const conversationHistory: Message[] = [
    {
      role: "system",
      content: `You are a helpful assistant. You have access to a spawn_subagent tool that creates a subagent with bash access.
Use spawn_subagent when the user needs to:
- Run shell commands
- Check system information
- Manipulate files
- Execute scripts

The subagent will handle the actual bash execution. You coordinate and report results.`,
    },
  ];

  while (true) {
    const userInput = await prompt();

    if (userInput.toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
      break;
    }

    if (!userInput.trim()) continue;

    conversationHistory.push({ role: "user", content: userInput });

    const orchestrator = new AgentOrchestrator();
    const spawnTool = createSpawnSubagentTool(orchestrator);

    const mainAgentId = orchestrator.spawn({
      model: "nvidia/nemotron-nano-9b-v2:free",
      messages: conversationHistory,
      tools: [spawnTool],
    });

    let assistantResponse = "";
    let outputMode: "text" | "reasoning" | null = null;

    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";

    for await (const { agentId, event } of orchestrator.events()) {
      const isMain = agentId === mainAgentId;
      const prefix = isMain ? "[main]" : "[sub] ";

      if (event.type === "text") {
        if (outputMode === "reasoning") process.stdout.write(RESET);
        outputMode = "text";
        process.stdout.write(event.content);
        if (isMain) assistantResponse += event.content;
      } else if (event.type === "reasoning") {
        if (outputMode !== "reasoning") process.stdout.write(DIM);
        outputMode = "reasoning";
        process.stdout.write(event.content);
      } else {
        if (outputMode === "reasoning") {
          process.stdout.write(RESET);
          outputMode = null;
        }
        if (event.type === "permission_required") {
          console.log(
            `\n${prefix} Permission required: ${event.tool}(${JSON.stringify(event.params)})`,
          );
          const answer = await new Promise<string>((resolve) => {
            rl.question("Approve? [y/N]: ", resolve);
          });
          const approved = answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
          orchestrator.resolvePermission(
            event.toolCallId,
            approved,
            approved ? undefined : "User denied",
          );
        } else if (event.type === "tool_call") {
          console.log(`\n${prefix} 🔧 ${event.name}(${JSON.stringify(event.input)})`);
        } else if (event.type === "tool_result") {
          console.log(`\n${prefix} ✅ Result:`, JSON.stringify(event.output, null, 2));
        } else if (event.type === "error") {
          console.error(`\n${prefix} ❌ Error:`, event.error.message);
        }
      }
    }

    if (outputMode === "reasoning") process.stdout.write(RESET);

    if (assistantResponse) {
      conversationHistory.push({ role: "assistant", content: assistantResponse });
    }

    console.log();
  }
}

await repl();
