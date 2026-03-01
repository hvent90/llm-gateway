import { Match, Show, Switch } from "solid-js";
import type { ReplAgent, ReplTurn } from "../../../ai/client/hypergraph";
import { phaseColor, phaseLabel, colors, type TabId } from "./theme";
import { ReasoningPanel, CodePanel, OutputPanel, AnswerPanel } from "./panels";
import type { PendingRelay } from "./repl-view";

interface MainPanelProps {
  agent: ReplAgent | null;
  turn: ReplTurn | null;
  turnIndex: number;
  totalTurns: number;
  activeTab: TabId;
  hasFinalAnswer: boolean;
  pendingRelays: PendingRelay[];
  isUserSelected: boolean;
  selectedUserMessage: string | null;
}

function StatusBar(props: {
  agent: ReplAgent | null;
  turn: ReplTurn | null;
  turnIndex: number;
  totalTurns: number;
}) {
  return (
    <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1}>
      <Show
        when={props.agent && props.turn}
        fallback={<text fg={colors.textMuted}>Select a turn</text>}
      >
        <text fg={colors.textPrimary}>
          Turn {props.turnIndex + 1}/{props.totalTurns}
        </text>
        <text fg={phaseColor(props.turn!.phase)}>
          {props.turn!.phase === "executing" ? "\u25C9 " : ""}
          {phaseLabel(props.turn!.phase)}
        </text>
        <Show when={props.turn!.output?.durationMs !== undefined}>
          <text fg={colors.textDim}>{(props.turn!.output!.durationMs! / 1000).toFixed(2)}s</text>
        </Show>
        <Show when={props.agent!.finalAnswer}>
          <text fg="#22c55e">FINAL</text>
        </Show>
      </Show>
    </box>
  );
}

function TabBar(props: { activeTab: TabId; hasFinalAnswer: boolean }) {
  const tabs = (): { id: TabId; label: string; key: string; show: boolean }[] => [
    { id: "reasoning", label: "Reason", key: "1", show: true },
    { id: "code", label: "Code", key: "2", show: true },
    { id: "output", label: "Output", key: "3", show: true },
    { id: "answer", label: "Answer", key: "4", show: props.hasFinalAnswer },
  ];

  return (
    <box flexDirection="row" gap={1} paddingLeft={1} borderColor={colors.border}>
      {tabs()
        .filter((t) => t.show)
        .map((tab) => (
          <text fg={props.activeTab === tab.id ? colors.textPrimary : colors.textMuted}>
            <Show when={props.activeTab === tab.id} fallback={` ${tab.key}:${tab.label} `}>
              <strong>
                [{tab.key}:{tab.label}]
              </strong>
            </Show>
          </text>
        ))}
    </box>
  );
}

function PermissionPrompt(props: { relay: PendingRelay }) {
  return (
    <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg="#e6b800">{"\u26A0"}</text>
      <text fg="#e6b800">{props.relay.tool}</text>
      <text fg={colors.textDim}>{JSON.stringify(props.relay.params)}</text>
      <text fg={colors.textMuted}>[y]allow [n]deny</text>
    </box>
  );
}

export function MainPanel(props: MainPanelProps) {
  return (
    <Show
      when={props.isUserSelected}
      fallback={
        <box flexDirection="column" flexGrow={1} backgroundColor={colors.mainBg}>
          <StatusBar
            agent={props.agent}
            turn={props.turn}
            turnIndex={props.turnIndex}
            totalTurns={props.totalTurns}
          />
          <TabBar activeTab={props.activeTab} hasFinalAnswer={props.hasFinalAnswer} />

          <Show
            when={props.turn}
            fallback={
              <box flexGrow={1} justifyContent="center" alignItems="center">
                <text fg={colors.textMuted}>Select a turn from the sidebar</text>
              </box>
            }
          >
            <Switch>
              <Match when={props.activeTab === "reasoning"}>
                <ReasoningPanel turn={props.turn!} />
              </Match>
              <Match when={props.activeTab === "code"}>
                <CodePanel turn={props.turn!} />
              </Match>
              <Match when={props.activeTab === "output"}>
                <OutputPanel turn={props.turn!} />
                {props.pendingRelays.map((relay) => (
                  <PermissionPrompt relay={relay} />
                ))}
              </Match>
              <Match when={props.activeTab === "answer"}>
                <AnswerPanel answer={props.agent?.finalAnswer ?? null} />
              </Match>
            </Switch>
          </Show>
        </box>
      }
    >
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.mainBg}>
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
          <text fg={colors.textDim}>User message</text>
        </box>
        <scrollbox
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={colors.textPrimary} wrapMode="word">
            {props.selectedUserMessage ?? ""}
          </text>
        </scrollbox>
      </box>
    </Show>
  );
}
