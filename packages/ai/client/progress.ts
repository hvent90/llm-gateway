/**
 * A pure reducer that accumulates tool_progress event content into typed state.
 * Co-located with tool implementations; registered here via manifest.
 */
export interface ToolProgressAccumulator<TState> {
  init(): TState;
  reduce(state: TState, content: unknown): TState;
}

// --- Manifest: import accumulators from tool implementations ---
import { execAccumulator } from "../rlm/exec-progress";

const accumulators: Record<string, ToolProgressAccumulator<unknown>> = {
  exec: execAccumulator,
};

/**
 * Fold a list of raw progress content values through the appropriate accumulator.
 * Returns null if no accumulator is registered for the given tool name.
 */
export function accumulate(name: string, contentValues: unknown[]): unknown | null {
  const acc = accumulators[name];
  if (!acc) return null;
  let state = acc.init();
  for (const content of contentValues) {
    state = acc.reduce(state, content);
  }
  return state;
}
