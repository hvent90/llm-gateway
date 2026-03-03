import { createSignal, createMemo, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";

export interface TaskInfo {
  name: string;
  difficulty: "easy" | "medium" | "hard" | "unknown";
  category: string;
  tags: string[];
  expertMin: number | null;
  juniorMin: number | null;
}

type DifficultyFilter = "all" | "easy" | "medium" | "hard";

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: "#44ff44",
  medium: "#e2b714",
  hard: "#ff4444",
  unknown: "#555",
};

const DIFFICULTY_FILTERS: DifficultyFilter[] = ["all", "easy", "medium", "hard"];

function parseDifficulty(val: unknown): TaskInfo["difficulty"] {
  if (val === "easy" || val === "medium" || val === "hard") return val;
  return "unknown";
}

export async function fetchTasks(): Promise<TaskInfo[]> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  // Prefer the venv-local harbor so the TUI works without activating the venv.
  // Falls back to whatever `harbor` is on PATH.
  const venvHarbor = join(import.meta.dir, "../.venv/bin/harbor");
  const harborBin = existsSync(venvHarbor) ? venvHarbor : "harbor";

  try {
    const download = Bun.spawn({
      cmd: [harborBin, "datasets", "download", "terminal-bench@2.0"],
      stdout: "ignore",
      stderr: "ignore",
    });
    // 30-second timeout so a missing/slow harbor doesn't hang the TUI forever
    await Promise.race([download.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30_000))]);
  } catch {
    // harbor not installed or download failed — fall through to read cache
  }

  const cacheDir = `${process.env.HOME}/.cache/harbor/tasks`;
  const { readdirSync, readFileSync } = await import("node:fs");

  if (!existsSync(cacheDir)) return [];

  const hashDirs = readdirSync(cacheDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  const tasks: TaskInfo[] = [];
  for (const hashDir of hashDirs) {
    const children = readdirSync(join(cacheDir, hashDir.name), { withFileTypes: true }).filter(
      (d) => d.isDirectory(),
    );
    for (const child of children) {
      const tomlPath = join(cacheDir, hashDir.name, child.name, "task.toml");
      let info: TaskInfo = {
        name: child.name,
        difficulty: "unknown",
        category: "",
        tags: [],
        expertMin: null,
        juniorMin: null,
      };
      try {
        const raw = readFileSync(tomlPath, "utf-8");
        const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
        const meta = parsed.metadata as Record<string, unknown> | undefined;
        if (meta) {
          info.difficulty = parseDifficulty(meta.difficulty);
          info.category = typeof meta.category === "string" ? meta.category : "";
          info.tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
          info.expertMin =
            typeof meta.expert_time_estimate_min === "number"
              ? meta.expert_time_estimate_min
              : null;
          info.juniorMin =
            typeof meta.junior_time_estimate_min === "number"
              ? meta.junior_time_estimate_min
              : null;
        }
      } catch {
        // task.toml missing or unparseable — keep defaults
      }
      tasks.push(info);
    }
  }
  return tasks.sort((a, b) => a.name.localeCompare(b.name));
}

export function TaskSelectScreen(props: {
  tasks: TaskInfo[];
  selected: string[];
  onConfirm: (selected: string[]) => void;
}) {
  const [selected, setSelected] = createSignal<Set<string>>(new Set(props.selected));
  const [cursor, setCursor] = createSignal(0);
  const [scrollOffset, setScrollOffset] = createSignal(0);
  const [difficultyFilter, setDifficultyFilter] = createSignal<DifficultyFilter>("all");
  const [categoryFilter, setCategoryFilter] = createSignal("All");
  const [focusZone, setFocusZone] = createSignal<"list" | "category">("list");
  const [categoryCursor, setCategoryCursor] = createSignal(0);
  const dimensions = useTerminalDimensions();
  // Reserve rows for: title (1) + spacer (1) + filter bar (1) + spacer (1) + scroll indicators (2) + category row (1) + footer (2) + padding (4) = 13
  const visibleRows = () => Math.max(4, dimensions().height - 13);

  const categories = createMemo(() => {
    const cats = new Set<string>();
    for (const t of props.tasks) {
      if (t.category) cats.add(t.category);
    }
    return ["All", ...Array.from(cats).sort()];
  });

  const filteredTasks = createMemo(() => {
    const diff = difficultyFilter();
    const cat = categoryFilter();
    return props.tasks.filter((t) => {
      if (diff !== "all" && t.difficulty !== diff) return false;
      if (cat !== "All" && t.category !== cat) return false;
      return true;
    });
  });

  const count = () => selected().size;
  const total = () => props.tasks.length;

  const visibleTasks = () => {
    const offset = scrollOffset();
    const rows = visibleRows();
    return filteredTasks().slice(offset, offset + rows);
  };

  const adjustScroll = (newCursor: number) => {
    const rows = visibleRows();
    let offset = scrollOffset();
    if (newCursor < offset) offset = newCursor;
    else if (newCursor >= offset + rows) offset = newCursor - rows + 1;
    setScrollOffset(offset);
  };

  const clampCursor = () => {
    const len = filteredTasks().length;
    if (len === 0) {
      setCursor(0);
      setScrollOffset(0);
      return;
    }
    const c = cursor();
    if (c >= len) {
      const clamped = len - 1;
      setCursor(clamped);
      adjustScroll(clamped);
    }
  };

  const toggle = (task: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(task)) next.delete(task);
      else next.add(task);
      return next;
    });
  };

  const setDifficultyAndClamp = (f: DifficultyFilter) => {
    setDifficultyFilter(f);
    setCursor(0);
    setScrollOffset(0);
  };

  const setCategoryAndClamp = (cat: string) => {
    setCategoryFilter(cat);
    setCursor(0);
    setScrollOffset(0);
  };

  const isFiltered = () => difficultyFilter() !== "all" || categoryFilter() !== "All";

  useKeyboard((key) => {
    if (focusZone() === "category") {
      const cats = categories();
      if (key.name === "up" || key.name === "k") {
        setCategoryCursor((c) => Math.max(0, c - 1));
      } else if (key.name === "down" || key.name === "j") {
        setCategoryCursor((c) => Math.min(cats.length - 1, c + 1));
      } else if (key.name === "enter" || key.name === "return") {
        const cat = cats[categoryCursor()];
        if (cat != null) setCategoryAndClamp(cat);
        setFocusZone("list");
      } else if (key.name === "tab") {
        setFocusZone("list");
      } else if (key.name === "escape") {
        setFocusZone("list");
      }
      // Difficulty shortcuts work in both zones
      if (key.raw === "1") setDifficultyAndClamp("all");
      else if (key.raw === "2") setDifficultyAndClamp("easy");
      else if (key.raw === "3") setDifficultyAndClamp("medium");
      else if (key.raw === "4") setDifficultyAndClamp("hard");
      return;
    }

    // list zone
    if (key.name === "space") {
      const task = filteredTasks()[cursor()];
      if (task) toggle(task.name);
    } else if (key.name === "up" || key.name === "k") {
      const next = Math.max(0, cursor() - 1);
      setCursor(next);
      adjustScroll(next);
    } else if (key.name === "down" || key.name === "j") {
      const next = Math.min(filteredTasks().length - 1, cursor() + 1);
      setCursor(next);
      adjustScroll(next);
    } else if (key.name === "a") {
      // Select all visible (filtered) tasks
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of filteredTasks()) next.add(t.name);
        return next;
      });
    } else if (key.name === "d") {
      // Deselect all visible (filtered) tasks
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of filteredTasks()) next.delete(t.name);
        return next;
      });
    } else if (key.name === "enter" || key.name === "return") {
      props.onConfirm(Array.from(selected()));
    } else if (key.name === "tab") {
      setFocusZone("category");
    } else if (key.name === "escape") {
      if (isFiltered()) {
        setDifficultyFilter("all");
        setCategoryFilter("All");
        setCursor(0);
        setScrollOffset(0);
      }
      // If not filtered, let parent handle escape
    }

    // Difficulty filter shortcuts
    if (key.raw === "1") setDifficultyAndClamp("all");
    else if (key.raw === "2") setDifficultyAndClamp("easy");
    else if (key.raw === "3") setDifficultyAndClamp("medium");
    else if (key.raw === "4") setDifficultyAndClamp("hard");
  });

  // Clamp cursor whenever filtered list changes
  createMemo(() => {
    filteredTasks();
    clampCursor();
  });

  const selectionLabel = () => {
    const n = count();
    const t = total();
    const f = filteredTasks().length;
    if (n === 0) return null;
    if (isFiltered()) return `${n} of ${t} selected (showing ${f})`;
    return `${n} of ${t} selected`;
  };

  // Pad task name to align columns
  const maxNameLen = createMemo(() => {
    let max = 0;
    for (const t of props.tasks) {
      if (t.name.length > max) max = t.name.length;
    }
    return max;
  });

  return (
    <box flexDirection="column" padding={2} flexGrow={1}>
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg="#00ffff">
          <strong>Select Tasks</strong>
        </text>
        <Show
          when={selectionLabel()}
          fallback={<text fg="#666">none selected — will run all</text>}
        >
          {(label: () => string) => <text fg="#e2b714">{label()}</text>}
        </Show>
      </box>

      {/* Filter bar */}
      <box flexDirection="row" gap={1} marginTop={1}>
        <text fg="#888">Filter:</text>
        <For each={DIFFICULTY_FILTERS}>
          {(f, i) => {
            const active = () => difficultyFilter() === f;
            const label = () => ` ${i() + 1}:${f} `;
            return (
              <box
                backgroundColor={
                  active() ? (f === "all" ? "#ccc" : DIFFICULTY_COLORS[f]) : undefined
                }
              >
                <text fg={active() ? "#000" : f === "all" ? "#ccc" : DIFFICULTY_COLORS[f]}>
                  {label()}
                </text>
              </box>
            );
          }}
        </For>
        <text fg="#555">│</text>
        <box backgroundColor={focusZone() === "category" ? "#1a2a3a" : undefined}>
          <text fg={focusZone() === "category" ? "#00ffff" : "#888"}>
            {" "}
            cat: {categoryFilter()}{" "}
          </text>
        </box>
      </box>

      <box height={1} />

      {/* Category picker (only when focused) */}
      <Show when={focusZone() === "category"}>
        <box flexDirection="column" border borderStyle="rounded" padding={1} maxHeight={8}>
          <text fg="#00ffff">
            <strong>Category</strong>
          </text>
          <For each={categories()}>
            {(cat, i) => {
              const isCur = () => i() === categoryCursor();
              const isActive = () => cat === categoryFilter();
              return (
                <box backgroundColor={isCur() ? "#1a2a3a" : undefined}>
                  <text fg={isActive() ? "#e2b714" : isCur() ? "#fff" : "#888"}>
                    {isCur() ? ">" : " "} {cat}
                  </text>
                </box>
              );
            }}
          </For>
        </box>
        <box height={1} />
      </Show>

      {/* Scroll-up indicator */}
      <Show when={scrollOffset() > 0}>
        <text fg="#555"> ↑ {scrollOffset()} more</text>
      </Show>

      {/* Task list */}
      <box flexDirection="column" flexGrow={1}>
        <Show when={filteredTasks().length === 0}>
          <text fg="#555">
            {props.tasks.length === 0
              ? "No tasks loaded — run `cd evals && uv sync` then restart"
              : "No tasks match the current filters"}
          </text>
        </Show>
        <For each={visibleTasks()}>
          {(task) => {
            const idx = () => filteredTasks().indexOf(task);
            const isCursor = () => idx() === cursor();
            const isChecked = () => selected().has(task.name);
            const padded = () => task.name.padEnd(maxNameLen());
            const diffColor = () => DIFFICULTY_COLORS[task.difficulty] ?? "#555";
            return (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={isCursor() && focusZone() === "list" ? "#1a2a3a" : undefined}
                onMouseDown={() => {
                  const i = idx();
                  setCursor(i);
                  adjustScroll(i);
                  toggle(task.name);
                }}
              >
                <text fg={isChecked() ? "#e2b714" : "#444"}>{isChecked() ? "[x]" : "[ ]"}</text>
                <text fg={isChecked() ? "#fff" : isCursor() ? "#ccc" : "#888"}>
                  <Show when={isChecked()} fallback={padded()}>
                    <strong>{padded()}</strong>
                  </Show>
                </text>
                <text fg={diffColor()}>{task.difficulty.padEnd(7)}</text>
                <text fg="#555">{task.category}</text>
              </box>
            );
          }}
        </For>
      </box>

      {/* Scroll-down indicator */}
      <Show when={scrollOffset() + visibleRows() < filteredTasks().length}>
        <text fg="#555"> ↓ {filteredTasks().length - scrollOffset() - visibleRows()} more</text>
      </Show>

      {/* Footer */}
      <box marginTop={1}>
        <text fg="#666">
          Space toggle • a all • d none • Enter confirm • 1-4 filter • Tab category • Esc{" "}
          {isFiltered() ? "clear filters" : "back"}
        </text>
      </box>
    </box>
  );
}
