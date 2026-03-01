import type { ReplAgent, ReplTurn } from "../../../../../packages/ai/client/hypergraph";

interface SidebarProps {
  agents: ReplAgent[];
  allAgents: Map<string, ReplAgent>;
  selectedRunId: string | null;
  selectedTurn: number;
  onSelectTurn: (runId: string, turnIndex: number) => void;
}

function phaseIcon(phase: ReplTurn["phase"]): string {
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

function phaseColor(phase: ReplTurn["phase"]): string {
  switch (phase) {
    case "executing":
      return "#569cd6";
    case "done":
      return "#6a9955";
    case "error":
      return "#cc4444";
    case "permission":
      return "#e6b800";
    default:
      return "#888";
  }
}

function statusColor(status: ReplAgent["status"]): string {
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

function statusLabel(status: ReplAgent["status"]): string {
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

function AgentTreeNode({
  agent,
  selectedRunId,
  selectedTurn,
  onSelectTurn,
  depth = 0,
}: {
  agent: ReplAgent;
  selectedRunId: string | null;
  selectedTurn: number;
  onSelectTurn: (runId: string, turnIndex: number) => void;
  depth?: number;
}) {
  const isSelected = selectedRunId === agent.runId;
  const shortId = agent.agentId || agent.runId.slice(-7);

  return (
    <div style={{ paddingLeft: depth * 12 }}>
      {/* Agent row */}
      <div
        className="flex cursor-pointer items-center gap-1 px-2"
        style={{
          height: 20,
          fontSize: 11,
          fontFamily: "Inter, sans-serif",
          backgroundColor: isSelected && selectedTurn === -1 ? "#264f78" : "transparent",
          color: "#d4d4d4",
        }}
        onClick={() => onSelectTurn(agent.runId, agent.turns.length > 0 ? 0 : -1)}
        onMouseEnter={(e) => {
          if (!(isSelected && selectedTurn === -1)) {
            e.currentTarget.style.backgroundColor = "#37373d";
          }
        }}
        onMouseLeave={(e) => {
          if (!(isSelected && selectedTurn === -1)) {
            e.currentTarget.style.backgroundColor = "transparent";
          }
        }}
      >
        <span
          style={{
            color: statusColor(agent.status),
            width: 10,
            flexShrink: 0,
            textAlign: "center",
          }}
        >
          {agent.status === "running" ? "\u25CF" : agent.status === "done" ? "\u2713" : "\u2717"}
        </span>
        <span
          className="min-w-0 flex-1 truncate"
          style={{ fontFamily: '"JetBrains Mono", monospace' }}
        >
          {shortId}
        </span>
        <span style={{ color: "#666", fontSize: 10 }}>{statusLabel(agent.status)}</span>
      </div>

      {/* Turn rows */}
      {agent.turns.map((turn, i) => {
        const turnSelected = isSelected && selectedTurn === i;
        return (
          <div
            key={i}
            className="flex cursor-pointer items-center gap-1 px-2"
            style={{
              height: 20,
              fontSize: 11,
              fontFamily: "Inter, sans-serif",
              paddingLeft: (depth + 1) * 12 + 8,
              backgroundColor: turnSelected ? "#264f78" : "transparent",
              color: turnSelected ? "#d4d4d4" : "#888",
            }}
            onClick={() => onSelectTurn(agent.runId, i)}
            onMouseEnter={(e) => {
              if (!turnSelected) e.currentTarget.style.backgroundColor = "#37373d";
            }}
            onMouseLeave={(e) => {
              if (!turnSelected) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <span
              style={{
                color: phaseColor(turn.phase),
                width: 10,
                flexShrink: 0,
                textAlign: "center",
                fontSize: 10,
              }}
            >
              {phaseIcon(turn.phase)}
            </span>
            <span className="truncate">Turn {turn.iteration}</span>
          </div>
        );
      })}

      {/* Recursively render child agents */}
      {agent.turns.map((turn, i) =>
        turn.childAgents.map((child) => (
          <AgentTreeNode
            key={child.runId}
            agent={child}
            selectedRunId={selectedRunId}
            selectedTurn={selectedTurn}
            onSelectTurn={onSelectTurn}
            depth={depth + 2}
          />
        )),
      )}
    </div>
  );
}

export function Sidebar({
  agents,
  allAgents,
  selectedRunId,
  selectedTurn,
  onSelectTurn,
}: SidebarProps) {
  // Compute aggregate stats
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalAgents = 0;
  let totalTurns = 0;
  for (const agent of allAgents.values()) {
    totalAgents++;
    totalTurns += agent.turns.length;
    if (agent.totalUsage) {
      totalTokensIn += agent.totalUsage.inputTokens;
      totalTokensOut += agent.totalUsage.outputTokens;
    }
  }

  return (
    <div
      className="flex flex-col"
      style={{
        width: 220,
        minWidth: 220,
        backgroundColor: "#252526",
        borderRight: "1px solid #333",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center px-3"
        style={{
          height: 28,
          borderBottom: "1px solid #333",
          fontSize: 11,
          fontFamily: "Inter, sans-serif",
          color: "#888",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Agents
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {agents.length === 0 ? (
          <div
            className="px-3 py-4"
            style={{ color: "#666", fontSize: 11, fontFamily: "Inter, sans-serif" }}
          >
            No agents yet
          </div>
        ) : (
          agents.map((agent) => (
            <AgentTreeNode
              key={agent.runId}
              agent={agent}
              selectedRunId={selectedRunId}
              selectedTurn={selectedTurn}
              onSelectTurn={onSelectTurn}
            />
          ))
        )}
      </div>

      {/* Footer stats */}
      <div
        className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2"
        style={{
          borderTop: "1px solid #333",
          fontSize: 10,
          fontFamily: '"JetBrains Mono", monospace',
          color: "#666",
        }}
      >
        <span>
          {totalAgents} agent{totalAgents !== 1 ? "s" : ""}
        </span>
        <span>
          {totalTurns} turn{totalTurns !== 1 ? "s" : ""}
        </span>
        {(totalTokensIn > 0 || totalTokensOut > 0) && (
          <span>{((totalTokensIn + totalTokensOut) / 1000).toFixed(1)}k tok</span>
        )}
      </div>
    </div>
  );
}
