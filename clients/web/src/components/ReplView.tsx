import { useState, useCallback, useEffect, useRef } from "react";
import { projectRepl } from "../../../../packages/ai/client/hypergraph";
import type { ConversationGraph, PendingRelay } from "../types";
import type { PermissionHandlers } from "./ConversationThread";
import { Sidebar } from "./repl/Sidebar";
import { MainPanel, type TabId } from "./repl/MainPanel";

interface ReplViewProps {
  graph: ConversationGraph;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}

const phaseToTab: Record<string, TabId> = {
  reasoning: "reasoning",
  code: "code",
  executing: "output",
  done: "output",
  error: "output",
  permission: "output",
};

export function ReplView({ graph, pendingRelays, permissionHandlers }: ReplViewProps) {
  const data = projectRepl(graph);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTurn, setSelectedTurn] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>("reasoning");
  const [userOverrodeTab, setUserOverrodeTab] = useState(false);
  const prevPhaseRef = useRef<string | null>(null);
  const prevTurnCountRef = useRef<number>(0);

  // Auto-select first agent if none selected
  useEffect(() => {
    if (!selectedRunId && data.agents.length > 0) {
      setSelectedRunId(data.agents[0]!.runId);
    }
  }, [data.agents, selectedRunId]);

  const agent = selectedRunId ? (data.allAgents.get(selectedRunId) ?? null) : null;
  const turn = agent && agent.turns[selectedTurn] ? agent.turns[selectedTurn] : null;
  const totalTurns = agent?.turns.length ?? 0;

  // Auto-advance to latest turn when new turns appear during streaming
  useEffect(() => {
    if (!agent) return;
    const count = agent.turns.length;
    if (count > prevTurnCountRef.current && prevTurnCountRef.current > 0) {
      setSelectedTurn(count - 1);
      setUserOverrodeTab(false);
    }
    prevTurnCountRef.current = count;
  }, [agent?.turns.length]);

  // Auto-switch tab when phase changes (unless user overrode)
  useEffect(() => {
    if (!turn || userOverrodeTab) return;
    const phase = turn.phase;
    if (phase !== prevPhaseRef.current) {
      prevPhaseRef.current = phase;
      const newTab = phaseToTab[phase];
      if (newTab) setActiveTab(newTab);
    }
  }, [turn?.phase, userOverrodeTab]);

  // Auto-switch to answer tab when final answer appears
  useEffect(() => {
    if (agent?.finalAnswer && !userOverrodeTab) {
      setActiveTab("answer");
    }
  }, [agent?.finalAnswer, userOverrodeTab]);

  const handleSelectTurn = useCallback((runId: string, turnIndex: number) => {
    setSelectedRunId(runId);
    setSelectedTurn(Math.max(0, turnIndex));
    setUserOverrodeTab(false);
    prevPhaseRef.current = null;
  }, []);

  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab);
    setUserOverrodeTab(true);
  }, []);

  return (
    <div className="flex flex-1 overflow-hidden" style={{ backgroundColor: "#1e1e1e" }}>
      <Sidebar
        agents={data.agents}
        allAgents={data.allAgents}
        selectedRunId={selectedRunId}
        selectedTurn={selectedTurn}
        onSelectTurn={handleSelectTurn}
      />
      <MainPanel
        agent={agent}
        turn={turn}
        turnIndex={selectedTurn}
        totalTurns={totalTurns}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        pendingRelays={pendingRelays}
        permissionHandlers={permissionHandlers}
      />
    </div>
  );
}
