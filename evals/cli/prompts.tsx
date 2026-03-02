import {
  createSignal,
  createMemo,
  createResource,
  For,
  Match,
  Show,
  Switch,
  type Accessor,
} from "solid-js";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { type EvalConfig, runEval } from "./runner";
import { CompareView } from "./compare";
import { createGeneratorHarness } from "../../packages/ai/harness/providers/claude-code.ts";
import { spawnSync } from "node:child_process";
import { TaskSelectScreen, fetchTasks } from "./task-select";
import { ModelSelectScreen } from "./model-select";
import { loadMostRecentEvalConfig } from "./load-jobs";
import {
  createInitialConversation,
  reduceConversation,
  projectRepl,
} from "../../packages/ai/client/hypergraph";
import type {
  ConversationState,
  ConversationEvent,
  ReplData,
} from "../../packages/ai/client/hypergraph";
import { ReplView } from "../../packages/ui/cli/repl";

type Screen =
  | "main"
  | "select-harness"
  | "select-dataset"
  | "select-tasks"
  | "select-model"
  | "select-concurrency"
  | "confirm"
  | "running"
  | "compare";

const HARNESSES = ["rlm"];
const DATASETS = ["terminal-bench@2.0"];
const CONCURRENCIES = ["1", "4", "8", "16", "32"];

const SELECT_STYLE = {
  showScrollIndicator: true,
  selectedBackgroundColor: "#1a2a3a",
  selectedTextColor: "#fff",
} as const;

const DEFAULT_MODEL = process.env.DEFAULT_MODEL;

async function fetchModels(): Promise<string[]> {
  const harness = createGeneratorHarness();
  return harness.supportedModels();
}

function runClipboardCommand(command: string[], text: string): boolean {
  const [file, ...args] = command;
  if (!file) return false;
  const result = spawnSync(file, args, { input: text });
  return !result.error && result.status === 0;
}

function copyToClipboard(text: string): boolean {
  const commands: string[][] = [];

  switch (process.platform) {
    case "darwin":
      commands.push(["pbcopy"]);
      break;
    case "win32":
      commands.push(["clip"]);
      break;
    default:
      if (process.env.WAYLAND_DISPLAY) commands.push(["wl-copy"]);
      commands.push(["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]);
      break;
  }

  for (const command of commands) {
    if (runClipboardCommand(command, text)) return true;
  }

  try {
    const encoded = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
    return true;
  } catch {
    return false;
  }
}

function MainMenu(props: {
  onRunEval: () => void;
  onQuickRun: () => void;
  onCompare: () => void;
  lastConfig: EvalConfig | null;
}) {
  const quickRunDescription = () => {
    if (!props.lastConfig) return "No previous run found yet (opens setup)";
    const taskSummary = props.lastConfig.taskNames.length > 0 ? `${props.lastConfig.taskNames.length} tasks` : "all tasks";
    return `${props.lastConfig.model} • ${props.lastConfig.dataset} • ${taskSummary} • n=${props.lastConfig.concurrency}`;
  };

  return (
    <box flexDirection="column" padding={2} flexGrow={1}>
      <ascii_font text="Eval Runner" font="tiny" color="#00ffff" />
      <box height={1} />
      <select
        options={[
          {
            name: "Run Eval",
            description: "Configure and run a Terminal-Bench evaluation",
            value: "run",
          },
          {
            name: "Quick Run Last Config",
            description: quickRunDescription(),
            value: "quick-run",
          },
          {
            name: "Compare Results",
            description: "View and compare evaluation results",
            value: "compare",
          },
        ]}
        onSelect={(_, opt) => {
          if (!opt) return;
          if (opt.value === "run") props.onRunEval();
          else if (opt.value === "quick-run") props.onQuickRun();
          else props.onCompare();
        }}
        focused
        flexGrow={1}
        {...SELECT_STYLE}
      />
    </box>
  );
}

function SelectScreen(props: {
  title: string;
  options: string[];
  selected: string;
  onSelect: (val: string) => void;
}) {
  const options = () => props.options.map((o) => ({ name: o, description: o, value: o }));
  const selectedIndex = () => props.options.indexOf(props.selected);

  return (
    <box flexDirection="column" padding={2} flexGrow={1}>
      <text fg="#00ffff">
        <strong>{props.title}</strong>
      </text>
      <box height={1} />
      <select
        options={options()}
        selectedIndex={selectedIndex()}
        onSelect={(_, opt) => opt && props.onSelect(opt.name)}
        focused
        flexGrow={1}
        {...SELECT_STYLE}
      />
      <box marginTop={1}>
        <text fg="#666">↑↓ navigate • Enter select • Esc back</text>
      </box>
    </box>
  );
}

function ConfirmScreen(props: {
  harness: string;
  dataset: string;
  taskNames: string[];
  totalTasks: number;
  model: string;
  concurrency: string;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const taskSummary = () => {
    if (props.taskNames.length === 0) return "all";
    return `${props.taskNames.length} of ${props.totalTasks} tasks`;
  };

  return (
    <box flexDirection="column" padding={2} flexGrow={1}>
      <text fg="#00ffff">
        <strong>Confirm Eval Configuration</strong>
      </text>
      <box height={1} />
      <box flexDirection="column" border padding={1} borderStyle="rounded">
        <box flexDirection="row" gap={1}>
          <box width={16}>
            <text fg="#888">Harness:</text>
          </box>
          <text fg="#fff">{props.harness}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <box width={16}>
            <text fg="#888">Dataset:</text>
          </box>
          <text fg="#fff">{props.dataset}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <box width={16}>
            <text fg="#888">Tasks:</text>
          </box>
          <text fg="#fff">{taskSummary()}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <box width={16}>
            <text fg="#888">Model:</text>
          </box>
          <text fg="#fff">{props.model}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <box width={16}>
            <text fg="#888">Concurrency:</text>
          </box>
          <text fg="#fff">{props.concurrency}</text>
        </box>
      </box>
      <box height={1} />
      <select
        options={[
          { name: "Run", description: "Start the evaluation", value: "run" },
          {
            name: "Back",
            description: "Return to configuration",
            value: "back",
          },
        ]}
        onSelect={(_, opt) => {
          if (!opt) return;
          if (opt.name === "Run") props.onConfirm();
          else props.onBack();
        }}
        focused
        flexGrow={1}
        {...SELECT_STYLE}
      />
    </box>
  );
}

function RunningScreen(props: {
  output: string[];
  exitCode: number | null;
  replData: Accessor<ReplData>;
  userMessage: Accessor<string | null>;
  onBack: () => void;
}) {
  const dimensions = useTerminalDimensions();
  const [copyStatus, setCopyStatus] = createSignal<"idle" | "success" | "error">("idle");
  const [view, setView] = createSignal<"repl" | "log">("repl");
  // Reserve rows for: footer (3) + padding (2) + title (1) + spacer (1) + status line (2) = 9
  const scrollboxHeight = () => Math.max(4, dimensions().height - 9);

  useKeyboard((key) => {
    if (key.name === "tab") {
      setView((v) => (v === "repl" ? "log" : "repl"));
    }
    if (key.name === "c" && view() === "log" && props.output.length > 0) {
      const didCopy = copyToClipboard(props.output.join("\n"));
      setCopyStatus(didCopy ? "success" : "error");
      setTimeout(() => setCopyStatus("idle"), 2000);
    }
  });

  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg="#00ffff">
          <strong>Running Eval</strong>
        </text>
        <box flexDirection="row" gap={2}>
          <text fg="#666">[{view() === "repl" ? "REPL" : "Log"}] Tab:toggle</text>
          <Show when={copyStatus() !== "idle"}>
            <text fg={copyStatus() === "success" ? "#44ff44" : "#ff4444"}>
              {copyStatus() === "success" ? "Copied!" : "Copy failed"}
            </text>
          </Show>
        </box>
      </box>
      <box height={1} />
      <Show
        when={view() === "repl"}
        fallback={
          <scrollbox height={scrollboxHeight()} focused={view() === "log"} stickyScroll stickyStart="bottom">
            <Show when={props.output.length === 0 && props.exitCode === null}>
              <text fg="#888">Waiting for output...</text>
            </Show>
            <For each={props.output}>{(line) => <text>{line || " "}</text>}</For>
          </scrollbox>
        }
      >
        <ReplView data={props.replData} focused={view() === "repl"} userMessage={props.userMessage} />
      </Show>
      <Show when={props.exitCode !== null}>
        <box marginTop={1}>
          <Show
            when={props.exitCode === 0}
            fallback={
              <text fg="#ff4444">
                Eval failed (exit code {props.exitCode}) — press Esc to return
              </text>
            }
          >
            <text fg="#44ff44">Eval completed successfully — press Esc to return</text>
          </Show>
        </box>
      </Show>
    </box>
  );
}

export function App() {
  const renderer = useRenderer();
  const [screen, setScreen] = createSignal<Screen>("main");
  const [storedLastConfig] = createResource(loadMostRecentEvalConfig);
  const [harness, setHarness] = createSignal(HARNESSES[0] ?? "rlm");
  const [dataset, setDataset] = createSignal(DATASETS[0] ?? "terminal-bench@2.0");
  const [models] = createResource(fetchModels);
  const [tasks] = createResource(fetchTasks);
  const defaultModel = () => {
    const list = models() ?? [];
    if (DEFAULT_MODEL) {
      const exact = list.find((m) => m === DEFAULT_MODEL);
      if (exact) return exact;
      const partial = list.find((m) => m.includes(DEFAULT_MODEL) || DEFAULT_MODEL.includes(m));
      if (partial) return partial;
    }
    return list[0] ?? "";
  };
  const [taskNames, setTaskNames] = createSignal<string[]>([]);
  const [model, setModel] = createSignal("");
  const [concurrency, setConcurrency] = createSignal("4");
  const [lastRunConfig, setLastRunConfig] = createSignal<EvalConfig | null>(null);
  const [output, setOutput] = createSignal<string[]>([]);
  const [exitCode, setExitCode] = createSignal<number | null>(null);
  const [conversation, setConversation] = createSignal<ConversationState>(
    createInitialConversation(),
  );
  const replData = createMemo(() => projectRepl(conversation().graph));
  const [userMessage, setUserMessage] = createSignal<string | null>(null);
  const [compareCount, setCompareCount] = createSignal(0);
  const quickRunConfig = createMemo<EvalConfig | null>(() => lastRunConfig() ?? storedLastConfig() ?? null);

  useKeyboard((key) => {
    if (key.name === "q") {
      renderer.destroy();
      return;
    }
    if (key.name === "escape") {
      switch (screen()) {
        case "select-harness":
          setScreen("main");
          break;
        case "select-dataset":
          setScreen("select-harness");
          break;
        case "select-tasks":
          setScreen("select-dataset");
          break;
        case "select-model":
          setScreen("select-tasks");
          break;
        case "select-concurrency":
          setScreen("select-model");
          break;
        case "confirm":
          setScreen("select-concurrency");
          break;
        case "running":
        case "compare":
          setScreen("main");
          break;
      }
    }
  });

  const runWithConfig = (config: EvalConfig) => {
    setScreen("running");
    setOutput([]);
    setExitCode(null);
    setLastRunConfig({ ...config, taskNames: [...config.taskNames] });
    setUserMessage(null);
    setConversation(createInitialConversation());
    setConversation((s) => reduceConversation(s, { type: "stream_start" }));

    runEval(
      config,
      (line) => {
        setOutput((prev) => [...prev, line]);
      },
      (event) => {
        const ev = event as Record<string, unknown>;
        if (ev.type === "user_prompt" && typeof ev.content === "string") {
          setUserMessage(ev.content);
          // Reset conversation for each new task (concurrent task isolation)
          setConversation(createInitialConversation());
          setConversation((s) => reduceConversation(s, { type: "stream_start" }));
          return;
        }
        setConversation((s) => reduceConversation(s, event as ConversationEvent));
      },
    )
      .then((code) => {
        setExitCode(code);
        setConversation((s) => reduceConversation(s, { type: "stream_end" }));
      })
      .catch((err: unknown) => {
        setOutput((prev) => [...prev, `Error: ${String(err)}`]);
        setExitCode(1);
        setConversation((s) => reduceConversation(s, { type: "stream_end" }));
      });
  };

  const startRun = () => {
    const parsedConcurrency = parseInt(concurrency(), 10);
    runWithConfig({
      harness: harness(),
      dataset: dataset(),
      taskNames: [...taskNames()],
      model: model() || defaultModel(),
      concurrency: Number.isInteger(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 4,
    });
  };

  const startQuickRun = () => {
    const config = quickRunConfig();
    if (!config) {
      setScreen("select-harness");
      return;
    }
    runWithConfig({ ...config, taskNames: [...config.taskNames] });
  };

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1} flexDirection="column">
        <Switch>
          <Match when={screen() === "main"}>
            <MainMenu
              onRunEval={() => setScreen("select-harness")}
              onQuickRun={startQuickRun}
              onCompare={() => {
                setCompareCount((c) => c + 1);
                setScreen("compare");
              }}
              lastConfig={quickRunConfig()}
            />
          </Match>
          <Match when={screen() === "select-harness"}>
            <SelectScreen
              title="Select Harness"
              options={HARNESSES}
              selected={harness()}
              onSelect={(val) => {
                setHarness(val);
                setScreen("select-dataset");
              }}
            />
          </Match>
          <Match when={screen() === "select-dataset"}>
            <SelectScreen
              title="Select Dataset"
              options={DATASETS}
              selected={dataset()}
              onSelect={(val) => {
                setDataset(val);
                setScreen("select-tasks");
              }}
            />
          </Match>
          <Match when={screen() === "select-tasks"}>
            <Show
              when={!tasks.loading}
              fallback={
                <box flexDirection="column" padding={2} flexGrow={1}>
                  <text fg="#888">Fetching tasks...</text>
                </box>
              }
            >
              <TaskSelectScreen
                tasks={tasks() ?? []}
                selected={taskNames()}
                onConfirm={(selected) => {
                  setTaskNames(selected);
                  setScreen("select-model");
                }}
              />
            </Show>
          </Match>
          <Match when={screen() === "select-model"}>
            <ModelSelectScreen
              models={models()}
              selected={model() || defaultModel()}
              onSelect={(val) => {
                setModel(val);
                setScreen("select-concurrency");
              }}
            />
          </Match>
          <Match when={screen() === "select-concurrency"}>
            <SelectScreen
              title="Select Concurrency"
              options={CONCURRENCIES}
              selected={concurrency()}
              onSelect={(val) => {
                setConcurrency(val);
                setScreen("confirm");
              }}
            />
          </Match>
          <Match when={screen() === "confirm"}>
            <ConfirmScreen
              harness={harness()}
              dataset={dataset()}
              taskNames={taskNames()}
              totalTasks={(tasks() ?? []).length}
              model={model() || defaultModel()}
              concurrency={concurrency()}
              onConfirm={startRun}
              onBack={() => setScreen("select-concurrency")}
            />
          </Match>
          <Match when={screen() === "running"}>
            <RunningScreen
              output={output()}
              exitCode={exitCode()}
              replData={replData}
              userMessage={userMessage}
              onBack={() => setScreen("main")}
            />
          </Match>
          <Match when={screen() === "compare"}>
            <CompareView trigger={compareCount} />
          </Match>
        </Switch>
      </box>
      <box padding={1}>
        <text fg="#555">q: quit • esc: back • tab: repl/log • c: copy output</text>
      </box>
    </box>
  );
}
