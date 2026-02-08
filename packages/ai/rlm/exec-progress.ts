import type { ToolProgressAccumulator } from "../client/progress";

export type ExecProgressState = {
  stdout: string;
  stderr: string;
  metrics: {
    pid: number;
    cpuPercent: number;
    rssKb: number;
    wallMs: number;
  } | null;
};

function isStreamChunk(content: unknown): content is { channel: "stdout" | "stderr"; data: string } {
  return (
    typeof content === "object" &&
    content !== null &&
    "channel" in content &&
    "data" in content &&
    ((content as any).channel === "stdout" || (content as any).channel === "stderr") &&
    typeof (content as any).data === "string"
  );
}

function isMetrics(
  content: unknown,
): content is { pid: number; cpuPercent: number; rssKb: number; wallMs: number } {
  return (
    typeof content === "object" &&
    content !== null &&
    "pid" in content &&
    typeof (content as any).pid === "number"
  );
}

export const execAccumulator: ToolProgressAccumulator<ExecProgressState> = {
  init: () => ({ stdout: "", stderr: "", metrics: null }),
  reduce(state, content) {
    if (isStreamChunk(content)) {
      return {
        ...state,
        [content.channel]: state[content.channel] + content.data,
      };
    }
    if (isMetrics(content)) {
      return {
        ...state,
        metrics: {
          pid: content.pid,
          cpuPercent: content.cpuPercent,
          rssKb: content.rssKb,
          wallMs: content.wallMs,
        },
      };
    }
    return state;
  },
};
