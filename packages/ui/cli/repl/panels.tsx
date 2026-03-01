import { Show, type JSX } from "solid-js";
import type { ReplTurn } from "../../../ai/client/hypergraph";
import { colors } from "./theme";

function Placeholder(props: { text: string }) {
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center">
      <text fg={colors.textMuted}>{props.text}</text>
    </box>
  );
}

function PanelScroll(props: { children: JSX.Element }) {
  return (
    <scrollbox
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <box flexDirection="column" gap={1}>
        {props.children}
      </box>
    </scrollbox>
  );
}

export function ReasoningPanel(props: { turn: ReplTurn }) {
  return (
    <Show
      when={props.turn.reasoning && props.turn.reasoning.length > 0}
      fallback={<Placeholder text="No reasoning yet" />}
    >
      <PanelScroll>
        <text wrapMode="word" fg={colors.textDim}>
          <em>{props.turn.reasoning!}</em>
        </text>
      </PanelScroll>
    </Show>
  );
}

export function CodePanel(props: { turn: ReplTurn }) {
  return (
    <Show
      when={props.turn.code && props.turn.code.length > 0}
      fallback={<Placeholder text="No code yet" />}
    >
      <PanelScroll>
        <text fg={colors.textPrimary} wrapMode="word">
          {props.turn.code!}
        </text>
      </PanelScroll>
    </Show>
  );
}

export function OutputPanel(props: { turn: ReplTurn }) {
  const hasContent = () =>
    props.turn.stdout || props.turn.stderr || props.turn.output || props.turn.errorMessage;

  return (
    <Show
      when={hasContent()}
      fallback={<Placeholder text={props.turn.code ? "Executing..." : "No output yet"} />}
    >
      <PanelScroll>
        <box flexDirection="column">
          <Show when={props.turn.errorMessage}>
            <box flexDirection="row" gap={1}>
              <text fg="#cc4444">
                <strong>ERROR</strong>
              </text>
              <text fg="#cc4444" wrapMode="word">
                {props.turn.errorMessage}
              </text>
            </box>
          </Show>
          <Show when={props.turn.stdout || props.turn.output?.stdout}>
            <text fg={colors.textPrimary} wrapMode="word">
              {props.turn.stdout || props.turn.output?.stdout}
            </text>
          </Show>
          <Show when={props.turn.stderr}>
            <text fg="#cc4444" wrapMode="word">
              {props.turn.stderr}
            </text>
          </Show>
          <Show when={props.turn.output?.error}>
            <text fg="#cc4444" wrapMode="word">
              {props.turn.output!.error}
            </text>
          </Show>
          <Show when={props.turn.output}>
            <box flexDirection="row" gap={2}>
              <Show when={props.turn.output!.durationMs !== undefined}>
                <text fg={colors.textMuted}>
                  {(props.turn.output!.durationMs! / 1000).toFixed(2)}s
                </text>
              </Show>
              <Show when={props.turn.output!.truncated}>
                <text fg="#e6b800">truncated</text>
              </Show>
            </box>
          </Show>
        </box>
      </PanelScroll>
    </Show>
  );
}

export function AnswerPanel(props: { answer: string | null }) {
  return (
    <Show when={props.answer} fallback={<Placeholder text="No final answer yet" />}>
      <PanelScroll>
        <text wrapMode="word" fg={colors.textPrimary}>
          {props.answer}
        </text>
      </PanelScroll>
    </Show>
  );
}
