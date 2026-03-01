import type { ReplPhase, ReplAgent } from "../../../ai/client/hypergraph";

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

export function phaseIcon(phase: ReplPhase): string {
  switch (phase) {
    case "idle":
      return "\u25CB"; // ○
    case "reasoning":
      return "\u25D4"; // ◔
    case "code":
      return "\u25A0"; // ■
    case "executing":
      return "\u25B6"; // ▶
    case "done":
      return "\u2713"; // ✓
    case "error":
      return "\u2717"; // ✗
    case "permission":
      return "\u26A0"; // ⚠
    default:
      return "\u25CB";
  }
}

export function phaseColor(phase: ReplPhase): string {
  switch (phase) {
    case "executing":
      return "#569cd6";
    case "done":
      return "#22c55e";
    case "error":
      return "#cc4444";
    case "permission":
      return "#e6b800";
    default:
      return "#888";
  }
}

export function phaseLabel(phase: ReplPhase): string {
  switch (phase) {
    case "idle":
      return "Idle";
    case "reasoning":
      return "Reasoning";
    case "code":
      return "Writing code";
    case "executing":
      return "Executing";
    case "done":
      return "Done";
    case "error":
      return "Error";
    case "permission":
      return "Awaiting permission";
    default:
      return phase;
  }
}

// ---------------------------------------------------------------------------
// Agent status helpers
// ---------------------------------------------------------------------------

export function statusColor(status: ReplAgent["status"]): string {
  switch (status) {
    case "running":
      return "#569cd6";
    case "done":
      return "#6a9955";
    case "error":
      return "#cc4444";
    case "max_iterations":
      return "#e6b800";
    default:
      return "#888";
  }
}

export function statusLabel(status: ReplAgent["status"]): string {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    case "max_iterations":
      return "max iter";
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type TabId = "reasoning" | "code" | "output" | "answer";

export const phaseToTab: Partial<Record<ReplPhase, TabId>> = {
  reasoning: "reasoning",
  code: "code",
  executing: "output",
  done: "output",
  error: "output",
  permission: "output",
};

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const colors = {
  sidebarBg: "#252526",
  mainBg: "#1e1e1e",
  selection: "#264f78",
  border: "#333",
  textPrimary: "#d4d4d4",
  textDim: "#888",
  textMuted: "#666",
} as const;
