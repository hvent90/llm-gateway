import { createSignal, createMemo, onMount, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";

export function ModelSelectScreen(props: {
  models: string[] | undefined;
  selected: string;
  onSelect: (val: string) => void;
}) {
  const models = createMemo(() => props.models ?? []);

  // Initialize cursor to the default/selected model index
  const initialIndex = () => {
    const idx = models().indexOf(props.selected);
    return idx >= 0 ? idx : 0;
  };
  const [cursor, setCursor] = createSignal(initialIndex());
  const [scrollOffset, setScrollOffset] = createSignal(0);
  const dimensions = useTerminalDimensions();
  // Reserve rows for: title (1) + spacer (1) + scroll indicators (2) + footer (2) + padding (4) = 10
  const visibleRows = () => Math.max(4, dimensions().height - 10);

  // Defer keyboard handling by one tick so the Enter keypress that
  // navigated here doesn't immediately trigger onSelect.
  const [active, setActive] = createSignal(false);
  onMount(() => setTimeout(() => setActive(true), 0));

  const visibleModels = () => {
    const offset = scrollOffset();
    const rows = visibleRows();
    return models().slice(offset, offset + rows);
  };

  const adjustScroll = (newCursor: number) => {
    const rows = visibleRows();
    let offset = scrollOffset();
    if (newCursor < offset) offset = newCursor;
    else if (newCursor >= offset + rows) offset = newCursor - rows + 1;
    setScrollOffset(offset);
  };

  // When models load, snap cursor to the default model
  createMemo(() => {
    const list = models();
    if (list.length > 0) {
      const idx = list.indexOf(props.selected);
      const target = idx >= 0 ? idx : 0;
      setCursor(target);
      adjustScroll(target);
    }
  });

  useKeyboard((key) => {
    if (!active()) return;
    const list = models();
    if (list.length === 0) return;

    if (key.name === "up" || key.name === "k") {
      const next = Math.max(0, cursor() - 1);
      setCursor(next);
      adjustScroll(next);
    } else if (key.name === "down" || key.name === "j") {
      const next = Math.min(list.length - 1, cursor() + 1);
      setCursor(next);
      adjustScroll(next);
    } else if (key.name === "enter" || key.name === "return") {
      const m = list[cursor()];
      if (m) props.onSelect(m);
    }
  });

  return (
    <box flexDirection="column" padding={2} flexGrow={1}>
      <text fg="#00ffff">
        <strong>Select Model</strong>
      </text>
      <box height={1} />
      <Show
        when={models().length > 0}
        fallback={
          <text fg="#888">
            {props.models == null ? "Fetching models..." : "No models available"}
          </text>
        }
      >
        <Show when={scrollOffset() > 0}>
          <text fg="#555"> ↑ {scrollOffset()} more</text>
        </Show>
        <box flexDirection="column" flexGrow={1}>
          <For each={visibleModels()}>
            {(model) => {
              const idx = () => models().indexOf(model);
              const isCursor = () => idx() === cursor();
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  backgroundColor={isCursor() ? "#1a2a3a" : undefined}
                  onMouseDown={() => {
                    const i = idx();
                    setCursor(i);
                    adjustScroll(i);
                    props.onSelect(model);
                  }}
                >
                  <text fg={isCursor() ? "#fff" : "#888"}>
                    <Show when={isCursor()} fallback={`  ${model}`}>
                      <strong>
                        {">"} {model}
                      </strong>
                    </Show>
                  </text>
                </box>
              );
            }}
          </For>
        </box>
        <Show when={scrollOffset() + visibleRows() < models().length}>
          <text fg="#555"> ↓ {models().length - scrollOffset() - visibleRows()} more</text>
        </Show>
      </Show>
      <box marginTop={1}>
        <text fg="#666">↑↓ navigate • Enter select • Esc back</text>
      </box>
    </box>
  );
}
