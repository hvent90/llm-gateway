import { OpenRouter, tool } from "@openrouter/sdk";
import { z } from "zod";
import { v7 } from "uuid";
import type {
  Message,
  ToolCall,
  HarnessEvent,
  Permissions,
  ToolExecutionResult,
} from "../packages/ai/types";

// ============ Types ============

export interface HarnessModule {
  invoke(params: InvokeParams): AsyncIterable<HarnessEvent>;
  supportedModels(): Promise<string[]>;
}

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

export interface ToolDefinition<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TResult = unknown,
> {
  name: string;
  description: string;
  schema: TSchema;
  execute?: (
    input: z.infer<TSchema>,
    ctx: ToolContext,
  ) => Promise<ToolExecutionResult<TResult>>;
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

// ============ Helpers ============

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function convertMessages(messages: Message[]) {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      return {
        role: "assistant" as const,
        content: msg.content ?? "",
      };
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

// ============ Harness ============

function createHarness(apiKey?: string): HarnessModule {
  const client = new OpenRouter({
    apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
  });

  return {
    async *invoke({
                    context,
                    ...params
                  }: InvokeParams): AsyncIterable<HarnessEventWithPermission> {
      const input = convertMessages(params.messages);
      const tools = params.tools ? convertTools(params.tools) : undefined;

      const runId = context?.runId ?? v7();
      const parentId = context?.parentId;
      const reasoningId = v7();
      const textId = v7();

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      const result = client.callModel({
        model: params.model,
        input,
        ...(tools && { tools }),
      } as Parameters<typeof client.callModel>[0]);

      const toolCalls: ToolCall[] = [];

      // Phase 1: Stream LLM output
      try {
        for await (const event of result.getFullResponsesStream()) {
          if (event.type === "response.output_text.delta") {
            yield tag({ type: "text", runId, id: textId, content: event.delta });
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

      // Phase 2: Execute tools sequentially
      for (const tc of toolCalls) {
        const toolDef = params.tools?.find((t) => t.name === tc.name);
        const args = (tc.arguments ?? {}) as Record<string, unknown>;

        // Check pre-denied list
        const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
        if (denial) {
          yield tag({
            type: "tool_result",
            runId,
            id: tc.id,
            name: tc.name,
            output: { status: "denied", reason: denial.reason },
          });
          continue;
        }

        // Request permission via deferred promise
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

        // Suspend until external code calls respond()
        const decision = await promise;

        if (!decision.approved) {
          yield tag({
            type: "tool_result",
            runId,
            id: tc.id,
            name: tc.name,
            output: { status: "denied", reason: decision.reason },
          });
          continue;
        }

        // Announce the tool call
        yield tag({
          type: "tool_call",
          runId,
          name: tc.name,
          id: tc.id,
          input: args,
        });

        // Execute if handler exists
        if (!toolDef?.execute) {
          continue;
        }

        const toolCtx: ToolContext = { parentId: tc.id };

        try {
          const { context: toolContext, result: toolResult } = await toolDef.execute(
            tc.arguments,
            toolCtx,
          );
          yield tag({
            type: "tool_result",
            runId,
            name: tc.name,
            id: tc.id,
            output: { context: toolContext, result: toolResult },
          });
        } catch (error) {
          yield tag({
            type: "error",
            runId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    },

    async supportedModels(): Promise<string[]> {
      const response = await client.models.list();
      return response.data.map((m: { id: string }) => m.id);
    },
  };
}

export const openRouterHarness = createHarness();

// ============ Tools ============

const bashTool: ToolDefinition = {
  name: "bash",
  description: "Execute a bash command and return the output",
  schema: z.object({
    command: z.string().describe("The bash command to execute"),
  }),
  execute: async (input) => {
    const proc = Bun.spawn(["bash", "-c", input.command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return {
      result: { stdout, stderr, exitCode },
      context: `Command: ${input.command}`,
    };
  },
};

// ============ REPL ============

async function repl() {
  const prompt = "> ";
  const rl = await import("readline");
  const reader = rl.createInterface({ input: process.stdin, output: process.stdout });

  const question = (q: string) => new Promise<string>((res) => reader.question(q, res));

  while (true) {
    const line = await question(prompt);
    if (!line.trim()) continue;

    try {
      const stream = openRouterHarness.invoke({
        model: "nvidia/nemotron-nano-9b-v2:free",
        messages: [{ role: "user", content: line }],
        tools: [bashTool],
      });

      for await (const event of stream) {
        if (event.type === "text" || event.type === "reasoning") {
          process.stdout.write(event.content);
        } else if (event.type === "permission_required") {
          // Auto-approve for REPL demo (or prompt user)
          const answer = await question(`\nAllow ${event.tool}? (y/n) `);
          event.respond(answer.toLowerCase() === "y");
        } else if (event.type === "tool_call") {
          console.log(`\n[tool_call: ${event.name}]`);
        } else if (event.type === "tool_result") {
          console.log(`\n[tool_result: ${event.name}]`, event.output);
        } else if (event.type === "error") {
          console.error(`\n[error]`, event.error);
        }
      }

      console.log(); // Newline after response
    } catch (e) {
      console.error(e);
    }
  }
}

await repl();