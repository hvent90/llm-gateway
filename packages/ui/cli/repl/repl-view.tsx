import { createSignal, createMemo, createEffect, on } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { Accessor } from "solid-js";
import type { ReplData } from "../../../ai/client/hypergraph";
import { type TabId, phaseToTab, colors } from "./theme";
import { Sidebar, flattenAgents, type FlatEntry, type SidebarEntry } from "./sidebar";
import { MainPanel } from "./main-panel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PendingRelay {
  relayId: string;
  runId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

export interface ReplViewProps {
  data: Accessor<ReplData>;
  pendingRelays?: Accessor<PendingRelay[]>;
  permissions?: PermissionHandlers;
  focused?: boolean;
  userMessage?: Accessor<string | null>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReplView(props: ReplViewProps) {
  const focused = () => props.focused ?? true;

  // --- state ---
  const [selectedRunId, setSelectedRunId] = createSignal<string | null>(null);
  const [selectedTurnIndex, setSelectedTurnIndex] = createSignal(0);
  const [selectedUser, setSelectedUser] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<TabId>("reasoning");
  const [userOverrodeTab, setUserOverrodeTab] = createSignal(false);
  const [userOverrideTurn, setUserOverrideTurn] = createSignal(false);
  const [cursorIndex, setCursorIndex] = createSignal(0);
  const [showHelp, setShowHelp] = createSignal(false);

  const dimensions = useTerminalDimensions();
  const sidebarWidth = () => (dimensions().width < 60 ? 0 : 24);
  const userMsg = () => {
    const msg = props.userMessage?.();
    return typeof msg === "string" ? msg.trim() : "";
  };

  // --- derived ---
  const flatEntries = createMemo<FlatEntry[]>(() => flattenAgents(props.data().agents));
  const sidebarEntries = createMemo<SidebarEntry[]>(() => {
    const entries = flatEntries();
    const msg = userMsg();
    return msg.length > 0 ? [{ type: "user", message: msg }, ...entries] : entries;
  });
  const selectedEntry = createMemo<SidebarEntry | null>(() => {
    const entries = sidebarEntries();
    if (entries.length === 0) return null;
    const idx = Math.max(0, Math.min(cursorIndex(), entries.length - 1));
    return entries[idx] ?? null;
  });
  const selectedUserMessage = createMemo(() => {
    const entry = selectedEntry();
    return entry?.type === "user" ? entry.message : null;
  });

  const agent = () => {
    const id = selectedRunId();
    return id ? (props.data().allAgents.get(id) ?? null) : null;
  };

  const turn = () => {
    const a = agent();
    return a ? (a.turns[selectedTurnIndex()] ?? null) : null;
  };

  const totalTurns = () => agent()?.turns.length ?? 0;
  const hasFinalAnswer = () => agent()?.finalAnswer != null;
  const pendingRelays = () => {
    const a = agent();
    const relays = props.pendingRelays?.() ?? [];
    return a ? relays.filter((r) => r.runId === a.runId) : [];
  };

  // --- helpers ---
  function selectEntry(entry: SidebarEntry) {
    if (entry.type === "user") {
      setSelectedUser(true);
      setSelectedRunId(null);
      setSelectedTurnIndex(0);
      setUserOverrodeTab(false);
      return;
    }

    setSelectedUser(false);
    setSelectedRunId(entry.runId);
    if (entry.type === "turn") {
      setSelectedTurnIndex(entry.turnIndex);
    } else {
      const a = props.data().allAgents.get(entry.runId);
      setSelectedTurnIndex(a && a.turns.length > 0 ? 0 : 0);
    }
    setUserOverrodeTab(false);
  }

  // --- auto-select: first available entry ---
  createEffect(
    on(sidebarEntries, (entries) => {
      if (entries.length === 0) {
        setSelectedRunId(null);
        setSelectedUser(false);
        setCursorIndex(0);
        return;
      }

      const clampedCursor = Math.min(cursorIndex(), entries.length - 1);
      if (clampedCursor !== cursorIndex()) {
        setCursorIndex(clampedCursor);
        return;
      }

      if (selectedUser() && !entries.some((e) => e.type === "user")) {
        setSelectedUser(false);
      }
      if (!selectedUser() && selectedRunId() && !props.data().allAgents.has(selectedRunId()!)) {
        setSelectedRunId(null);
      }
      if (!selectedUser() && !selectedRunId()) {
        selectEntry(entries[clampedCursor]!);
      }
    }),
  );

  // Keep model selection synchronized with highlighted sidebar row.
  createEffect(
    on(
      () => [cursorIndex(), sidebarEntries()] as const,
      ([idx, entries]) => {
        if (entries.length === 0) return;
        const entry = entries[Math.max(0, Math.min(idx, entries.length - 1))]!;

        if (entry.type === "user") {
          if (!selectedUser()) selectEntry(entry);
          return;
        }

        if (selectedUser()) {
          selectEntry(entry);
          return;
        }

        if (selectedRunId() !== entry.runId) {
          selectEntry(entry);
          return;
        }

        if (entry.type === "turn" && selectedTurnIndex() !== entry.turnIndex) {
          selectEntry(entry);
          return;
        }

        if (entry.type === "agent" && selectedTurnIndex() !== 0) {
          selectEntry(entry);
        }
      },
    ),
  );

  // --- auto-advance: follow latest turn ---
  let prevTurnCount = 0;
  createEffect(
    on(totalTurns, (count) => {
      if (selectedUser()) {
        prevTurnCount = count;
        return;
      }

      if (count > prevTurnCount && prevTurnCount > 0 && !userOverrideTurn()) {
        setSelectedTurnIndex(count - 1);
        setUserOverrodeTab(false);
        // Also advance cursor to match
        const entries = sidebarEntries();
        const idx = entries.findIndex(
          (e) =>
            e.type !== "user" &&
            e.runId === selectedRunId() &&
            e.type === "turn" &&
            e.turnIndex === count - 1,
        );
        if (idx >= 0) setCursorIndex(idx);
      }
      prevTurnCount = count;
    }),
  );

  // --- auto-advance: switch tab on phase change ---
  let prevPhase: string | null = null;
  createEffect(
    on(
      () => turn()?.phase,
      (phase) => {
        if (!phase || userOverrodeTab() || selectedUser()) return;
        if (phase !== prevPhase) {
          prevPhase = phase;
          const newTab = phaseToTab[phase];
          if (newTab) setActiveTab(newTab);
        }
      },
    ),
  );

  // --- auto-advance: answer tab on final answer ---
  createEffect(
    on(hasFinalAnswer, (has) => {
      if (has && !userOverrodeTab() && !selectedUser()) {
        setActiveTab("answer");
      }
    }),
  );

  // --- keyboard ---
  useKeyboard((key) => {
    if (!focused()) return;

    const entries = sidebarEntries();

    switch (key.name) {
      case "j":
      case "down": {
        const next = Math.min(entries.length - 1, cursorIndex() + 1);
        setCursorIndex(next);
        if (entries[next]) selectEntry(entries[next]!);
        break;
      }
      case "k":
      case "up": {
        const prev = Math.max(0, cursorIndex() - 1);
        setCursorIndex(prev);
        if (entries[prev]) selectEntry(entries[prev]!);
        break;
      }
      case "return": {
        const entry = entries[cursorIndex()];
        if (entry) selectEntry(entry);
        break;
      }
      case "1":
        setActiveTab("reasoning");
        setUserOverrodeTab(true);
        break;
      case "2":
        setActiveTab("code");
        setUserOverrodeTab(true);
        break;
      case "3":
        setActiveTab("output");
        setUserOverrodeTab(true);
        break;
      case "4":
        if (hasFinalAnswer()) {
          setActiveTab("answer");
          setUserOverrodeTab(true);
        }
        break;
      case "[": {
        if (selectedUser()) break;
        const idx = selectedTurnIndex();
        if (idx > 0) {
          setSelectedTurnIndex(idx - 1);
          setUserOverrideTurn(true);
          setUserOverrodeTab(false);
        }
        break;
      }
      case "]": {
        if (selectedUser()) break;
        const idx = selectedTurnIndex();
        if (idx < totalTurns() - 1) {
          const next = idx + 1;
          setSelectedTurnIndex(next);
          if (next === totalTurns() - 1) setUserOverrideTurn(false);
          setUserOverrodeTab(false);
        }
        break;
      }
      case "a":
        setUserOverrodeTab(false);
        setUserOverrideTurn(false);
        break;
      case "y": {
        const relays = pendingRelays();
        if (relays.length > 0 && props.permissions) {
          props.permissions.onAllow(relays[0]!);
        }
        break;
      }
      case "n": {
        const relays = pendingRelays();
        if (relays.length > 0 && props.permissions) {
          props.permissions.onDeny(relays[0]!);
        }
        break;
      }
      case "?":
        setShowHelp((v) => !v);
        break;
    }
  });

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexGrow={1}>
        {sidebarWidth() > 0 && (
          <Sidebar data={props.data()} cursorIndex={cursorIndex()} entries={sidebarEntries()} />
        )}
        <MainPanel
          agent={agent()}
          turn={turn()}
          turnIndex={selectedTurnIndex()}
          totalTurns={totalTurns()}
          activeTab={activeTab()}
          hasFinalAnswer={hasFinalAnswer()}
          pendingRelays={pendingRelays()}
          isUserSelected={selectedUser()}
          selectedUserMessage={selectedUserMessage() ?? userMsg()}
        />
      </box>

      {showHelp() ? (
        <box paddingLeft={1}>
          <text fg={colors.textDim}>j/k:nav 1-4:tab [:prev ]:next a:auto y/n:perm ?:close</text>
        </box>
      ) : (
        <box paddingLeft={1}>
          <text fg={colors.textMuted}>j/k:nav 1-4:tab [:prev ]:next a:auto y/n:perm ?:help</text>
        </box>
      )}
    </box>
  );
}
