import { For, Show } from "solid-js";
import type { ReplAgent, ReplData } from "../../../ai/client/hypergraph";
import { phaseIcon, phaseColor, statusColor, statusLabel, colors } from "./theme";

interface SidebarProps {
  data: ReplData;
  cursorIndex: number;
  entries: SidebarEntry[];
}

export interface FlatEntry {
  type: "agent" | "turn";
  runId: string;
  turnIndex: number; // -1 for agent rows
  depth: number;
}

export interface UserEntry {
  type: "user";
  message: string;
}

export type SidebarEntry = FlatEntry | UserEntry;

export function flattenAgents(agents: ReplAgent[], depth: number = 0): FlatEntry[] {
  const entries: FlatEntry[] = [];
  for (const agent of agents) {
    entries.push({ type: "agent", runId: agent.runId, turnIndex: -1, depth });
    for (let i = 0; i < agent.turns.length; i++) {
      entries.push({ type: "turn", runId: agent.runId, turnIndex: i, depth: depth + 1 });
      if (agent.turns[i]!.childAgents.length > 0) {
        entries.push(...flattenAgents(agent.turns[i]!.childAgents, depth + 2));
      }
    }
  }
  return entries;
}

function AgentRow(props: { agent: ReplAgent; selected: boolean; depth: number }) {
  const shortId = () => (props.agent.agentId || props.agent.runId).slice(-7);
  const icon = () => {
    switch (props.agent.status) {
      case "running":
        return "\u25CF"; // ●
      case "done":
        return "\u2713"; // ✓
      default:
        return "\u2717"; // ✗
    }
  };

  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={props.depth * 2}
      backgroundColor={props.selected ? colors.selection : undefined}
    >
      <text fg={statusColor(props.agent.status)}>{icon()}</text>
      <text fg={colors.textPrimary}>{shortId()}</text>
      <text fg={colors.textMuted}>{statusLabel(props.agent.status)}</text>
    </box>
  );
}

function TurnRow(props: { agent: ReplAgent; turnIndex: number; selected: boolean; depth: number }) {
  const turn = () => props.agent.turns[props.turnIndex]!;

  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={props.depth * 2}
      backgroundColor={props.selected ? colors.selection : undefined}
    >
      <text fg={phaseColor(turn().phase)}>{phaseIcon(turn().phase)}</text>
      <text fg={props.selected ? colors.textPrimary : colors.textDim}>Turn {turn().iteration}</text>
    </box>
  );
}

function Stats(props: { data: ReplData }) {
  const stats = () => {
    let agents = 0;
    let turns = 0;
    let tokens = 0;
    for (const agent of props.data.allAgents.values()) {
      agents++;
      turns += agent.turns.length;
      if (agent.totalUsage) {
        tokens += agent.totalUsage.inputTokens + agent.totalUsage.outputTokens;
      }
    }
    return { agents, turns, tokens };
  };

  return (
    <box
      flexDirection="row"
      gap={2}
      border
      borderStyle="single"
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={colors.textMuted}>
        {stats().agents} agent{stats().agents !== 1 ? "s" : ""}
      </text>
      <text fg={colors.textMuted}>
        {stats().turns} turn{stats().turns !== 1 ? "s" : ""}
      </text>
      <Show when={stats().tokens > 0}>
        <text fg={colors.textMuted}>{(stats().tokens / 1000).toFixed(1)}k tok</text>
      </Show>
    </box>
  );
}

function UserPromptRow(props: { message: string; selected: boolean }) {
  const normalized = () => props.message.replace(/\s+/g, " ").trim();
  const preview = () => {
    const text = normalized();
    return text.length > 11 ? text.slice(0, 8).trimEnd() + "..." : text;
  };

  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={0}
      backgroundColor={props.selected ? colors.selection : undefined}
    >
      <text fg={colors.textDim}>{">"}</text>
      <text fg={props.selected ? colors.textPrimary : colors.textDim}>User</text>
      <text fg={colors.textMuted}>{preview()}</text>
    </box>
  );
}

export function Sidebar(props: SidebarProps) {
  return (
    <box
      flexDirection="column"
      width={24}
      borderStyle="single"
      borderColor={colors.border}
      backgroundColor={colors.sidebarBg}
    >
      <box paddingLeft={1}>
        <text fg={colors.textDim}>
          <strong>AGENTS</strong>
        </text>
      </box>

      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <Show
          when={props.entries.length > 0}
          fallback={
            <box paddingLeft={1}>
              <text fg={colors.textMuted}>No agents yet</text>
            </box>
          }
        >
          <For each={props.entries}>
            {(entry, i) => {
              const selected = () => i() === props.cursorIndex;
              if (entry.type === "user") {
                return <UserPromptRow message={entry.message} selected={selected()} />;
              }

              const agent = () => props.data.allAgents.get(entry.runId)!;

              return (
                <Show
                  when={entry.type === "agent"}
                  fallback={
                    <TurnRow
                      agent={agent()}
                      turnIndex={entry.turnIndex}
                      selected={selected()}
                      depth={entry.depth}
                    />
                  }
                >
                  <AgentRow agent={agent()} selected={selected()} depth={entry.depth} />
                </Show>
              );
            }}
          </For>
        </Show>
      </scrollbox>

      <Stats data={props.data} />
    </box>
  );
}
