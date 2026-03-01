import { v7 as uuidv7 } from "uuid";
import type { GeneratorHarnessModule, GeneratorInvokeParams, HarnessEvent } from "../../types";

/**
 * A scripted event that the deterministic harness will yield.
 */
export type ScriptedEvent =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

/**
 * A scripted response — one invoke() call consumes one response.
 */
export interface ScriptedResponse {
  events: ScriptedEvent[];
}

/**
 * Configuration for the deterministic harness.
 */
export interface DeterministicHarnessConfig {
  responses: ScriptedResponse[];
  models?: string[];
  model?: string;
}

/**
 * Creates a deterministic provider harness that yields scripted event sequences.
 *
 * This is a real GeneratorHarnessModule — single-iteration, no looping,
 * no tool execution (that's the agent wrapper's job). Successive invoke()
 * calls consume the next scripted response.
 *
 * Each invoke() assigns its own runId (uuidv7), forwards context.parentId,
 * and generates unique event ids — matching real provider harness behavior.
 */
export function createDeterministicHarness(
  config: DeterministicHarnessConfig,
): GeneratorHarnessModule {
  let callIndex = 0;
  const defaultModel = config.model;

  return {
    async *invoke({ env, model: invokeModel }: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const model = invokeModel ?? defaultModel;
      if (!model) {
        throw new Error("No model specified: provide model at harness creation or invoke time");
      }
      const runId = uuidv7();
      const parentId = env?.parentId;

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      const response = config.responses[callIndex];
      if (!response) {
        yield tag({
          type: "error",
          runId,
          error: new Error(`Deterministic harness: no scripted response at index ${callIndex}`),
        });
        return;
      }
      callIndex++;

      for (const scripted of response.events) {
        switch (scripted.type) {
          case "text":
            yield tag({ type: "text", runId, id: uuidv7(), content: scripted.content });
            break;
          case "reasoning":
            yield tag({ type: "reasoning", runId, id: uuidv7(), content: scripted.content });
            break;
          case "tool_call":
            yield tag({
              type: "tool_call",
              runId,
              id: uuidv7(),
              name: scripted.name,
              input: scripted.input,
            });
            break;
          case "usage":
            yield tag({
              type: "usage",
              runId,
              inputTokens: scripted.inputTokens,
              outputTokens: scripted.outputTokens,
            });
            break;
          case "error":
            yield tag({ type: "error", runId, error: new Error(scripted.message) });
            return; // Stop on error, matching real provider behavior
        }
      }
    },

    async supportedModels(): Promise<string[]> {
      return config.models ?? ["deterministic"];
    },
  };
}
