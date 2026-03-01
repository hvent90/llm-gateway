import type { ReplAgent, ReplTurn, ReplPhase } from "../../../../../packages/ai/client/hypergraph";
import type { PendingRelay } from "../../types";
import type { PermissionHandlers } from "../ConversationThread";
import { ReasoningPanel, CodePanel, OutputPanel, AnswerPanel } from "./panels";

export type TabId = "reasoning" | "code" | "output" | "answer";

interface MainPanelProps {
  agent: ReplAgent | null;
  turn: ReplTurn | null;
  turnIndex: number;
  totalTurns: number;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}

function phaseLabel(phase: ReplPhase): string {
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

function phaseColor(phase: ReplPhase): string {
  switch (phase) {
    case "executing":
      return "#569cd6";
    case "done":
      return "#22c55e";
    case "error":
      return "#cc4444";
    case "permission":
      return "#e6b800";
    case "reasoning":
      return "#888";
    case "code":
      return "#888";
    default:
      return "#666";
  }
}

function StatusBar({
  agent,
  turn,
  turnIndex,
  totalTurns,
}: {
  agent: ReplAgent | null;
  turn: ReplTurn | null;
  turnIndex: number;
  totalTurns: number;
}) {
  if (!agent || !turn) {
    return (
      <div
        className="flex items-center px-3"
        style={{
          height: 24,
          borderBottom: "1px solid #333",
          fontSize: 11,
          fontFamily: "Inter, sans-serif",
          color: "#666",
        }}
      >
        Select a turn
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-3 px-3"
      style={{
        height: 24,
        borderBottom: "1px solid #333",
        fontSize: 11,
        fontFamily: "Inter, sans-serif",
        color: "#888",
      }}
    >
      <span style={{ color: "#d4d4d4" }}>
        Turn {turnIndex + 1}/{totalTurns}
      </span>
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
        style={{
          fontSize: 10,
          backgroundColor: phaseColor(turn.phase) + "22",
          color: phaseColor(turn.phase),
          border: `1px solid ${phaseColor(turn.phase)}44`,
        }}
      >
        {turn.phase === "executing" && (
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ backgroundColor: "#569cd6" }}
          />
        )}
        {phaseLabel(turn.phase)}
      </span>
      {turn.output?.durationMs !== undefined && (
        <span>{(turn.output.durationMs / 1000).toFixed(2)}s</span>
      )}
      {agent.finalAnswer && <span style={{ color: "#22c55e" }}>FINAL</span>}
    </div>
  );
}

function TabBar({
  activeTab,
  onTabChange,
  hasFinalAnswer,
  turn,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  hasFinalAnswer: boolean;
  turn: ReplTurn | null;
}) {
  const tabs: { id: TabId; label: string; show: boolean }[] = [
    { id: "reasoning", label: "Reasoning", show: true },
    { id: "code", label: "Code", show: true },
    { id: "output", label: "Output", show: true },
    { id: "answer", label: "Answer", show: hasFinalAnswer },
  ];

  return (
    <div
      className="flex items-center"
      style={{
        height: 28,
        borderBottom: "1px solid #333",
        fontFamily: "Inter, sans-serif",
        fontSize: 11,
      }}
    >
      {tabs
        .filter((t) => t.show)
        .map((tab) => (
          <button
            key={tab.id}
            className="flex items-center px-3"
            style={{
              height: "100%",
              color: activeTab === tab.id ? "#d4d4d4" : "#666",
              borderBottom: activeTab === tab.id ? "2px solid #569cd6" : "2px solid transparent",
              background: "none",
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
              fontSize: 11,
            }}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
            {tab.id === "answer" && (
              <span
                className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: "#22c55e" }}
              />
            )}
          </button>
        ))}
    </div>
  );
}

function PermissionPromptInline({
  relay,
  permissionHandlers,
}: {
  relay: PendingRelay;
  permissionHandlers: PermissionHandlers;
}) {
  const paramsOneLine = JSON.stringify(relay.params).replace(/,/g, ", ");
  return (
    <div
      className="mx-4 my-2 flex items-center gap-2 px-2 py-1"
      style={{ border: "1px solid #e6b800", fontSize: 11, fontFamily: "Inter, sans-serif" }}
    >
      <span style={{ color: "#e6b800", fontFamily: '"JetBrains Mono", monospace' }}>
        {relay.tool}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        style={{ color: "#888", fontFamily: '"JetBrains Mono", monospace' }}
      >
        {paramsOneLine}
      </span>
      <span className="flex shrink-0 gap-1">
        <button
          onClick={() => permissionHandlers.onAllow(relay)}
          className="px-2 py-0.5"
          style={{
            border: "1px solid #666",
            color: "#d4d4d4",
            fontSize: 10,
            cursor: "pointer",
            background: "none",
          }}
        >
          allow
        </button>
        <button
          onClick={() => permissionHandlers.onAllowAll(relay)}
          className="px-2 py-0.5"
          style={{
            border: "1px solid #666",
            color: "#d4d4d4",
            fontSize: 10,
            cursor: "pointer",
            background: "none",
          }}
        >
          always
        </button>
        <button
          onClick={() => permissionHandlers.onDeny(relay)}
          className="px-2 py-0.5"
          style={{
            border: "1px solid #666",
            color: "#888",
            fontSize: 10,
            cursor: "pointer",
            background: "none",
          }}
        >
          deny
        </button>
      </span>
    </div>
  );
}

export function MainPanel({
  agent,
  turn,
  turnIndex,
  totalTurns,
  activeTab,
  onTabChange,
  pendingRelays,
  permissionHandlers,
}: MainPanelProps) {
  const hasFinalAnswer = agent?.finalAnswer != null;
  const agentRelays = agent ? pendingRelays.filter((r) => r.runId === agent.runId) : [];

  return (
    <div className="flex flex-1 flex-col" style={{ backgroundColor: "#1e1e1e" }}>
      <StatusBar agent={agent} turn={turn} turnIndex={turnIndex} totalTurns={totalTurns} />
      <TabBar
        activeTab={activeTab}
        onTabChange={onTabChange}
        hasFinalAnswer={hasFinalAnswer}
        turn={turn}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {!turn ? (
          <div
            className="flex flex-1 items-center justify-center"
            style={{ color: "#666", fontFamily: "Inter, sans-serif", fontSize: 12 }}
          >
            Select a turn from the sidebar
          </div>
        ) : (
          <>
            {activeTab === "reasoning" && <ReasoningPanel turn={turn} />}
            {activeTab === "code" && <CodePanel turn={turn} />}
            {activeTab === "output" && (
              <>
                <OutputPanel turn={turn} />
                {agentRelays.map((relay) => (
                  <PermissionPromptInline
                    key={relay.relayId}
                    relay={relay}
                    permissionHandlers={permissionHandlers}
                  />
                ))}
              </>
            )}
            {activeTab === "answer" && <AnswerPanel answer={agent?.finalAnswer ?? null} />}
          </>
        )}
      </div>
    </div>
  );
}
