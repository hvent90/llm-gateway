import { Streamdown } from "streamdown";
import type { ReplTurn } from "../../../../../packages/ai/client/hypergraph";

export function ReasoningPanel({ turn }: { turn: ReplTurn }) {
  if (!turn.reasoning) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        style={{ color: "#666", fontFamily: "Inter, sans-serif", fontSize: 12 }}
      >
        No reasoning yet
      </div>
    );
  }
  return (
    <div
      className="flex-1 overflow-auto p-4 streamdown"
      style={{
        color: "#d4d4d4",
        fontFamily: "Inter, sans-serif",
        fontSize: 13,
        lineHeight: "20px",
      }}
    >
      <Streamdown>{turn.reasoning}</Streamdown>
    </div>
  );
}

export function CodePanel({ turn }: { turn: ReplTurn }) {
  if (!turn.code) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        style={{ color: "#666", fontFamily: "Inter, sans-serif", fontSize: 12 }}
      >
        No code yet
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto" style={{ backgroundColor: "#1a1a1a" }}>
      <pre
        className="p-4 select-text"
        style={{
          color: "#d4d4d4",
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 11,
          lineHeight: "18px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: 0,
        }}
      >
        {turn.code}
      </pre>
    </div>
  );
}

export function OutputPanel({ turn }: { turn: ReplTurn }) {
  const hasStreaming = turn.stdout || turn.stderr;
  const hasOutput = turn.output;
  const hasError = turn.errorMessage;

  if (!hasStreaming && !hasOutput && !hasError) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        style={{ color: "#666", fontFamily: "Inter, sans-serif", fontSize: 12 }}
      >
        {turn.code ? "Executing..." : "No output yet"}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto" style={{ backgroundColor: "#0d0d0d" }}>
      {hasError && (
        <div className="flex items-start gap-3 p-4" style={{ borderBottom: "1px solid #333" }}>
          <span
            style={{
              color: "#cc4444",
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            ERROR
          </span>
          <pre
            className="select-text"
            style={{
              color: "#cc4444",
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              lineHeight: "18px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
            }}
          >
            {turn.errorMessage}
          </pre>
        </div>
      )}
      {(turn.stdout || turn.output?.stdout) && (
        <pre
          className="flex-1 p-4 select-text"
          style={{
            color: "#d4d4d4",
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            lineHeight: "18px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
          }}
        >
          {turn.stdout || turn.output?.stdout}
        </pre>
      )}
      {turn.stderr && (
        <pre
          className="p-4 select-text"
          style={{
            color: "#cc4444",
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            lineHeight: "18px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
          }}
        >
          {turn.stderr}
        </pre>
      )}
      {turn.output?.error && (
        <pre
          className="p-4 select-text"
          style={{
            color: "#cc4444",
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            lineHeight: "18px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
            borderTop: "1px solid #333",
          }}
        >
          {turn.output.error}
        </pre>
      )}
      {turn.output && (
        <div
          className="flex items-center gap-3 px-4 py-2"
          style={{
            borderTop: "1px solid #333",
            color: "#666",
            fontSize: 11,
            fontFamily: "Inter, sans-serif",
          }}
        >
          {turn.output.durationMs !== undefined && (
            <span>{(turn.output.durationMs / 1000).toFixed(2)}s</span>
          )}
          {turn.output.truncated && <span style={{ color: "#e6b800" }}>truncated</span>}
        </div>
      )}
    </div>
  );
}

export function AnswerPanel({ answer }: { answer: string | null }) {
  if (!answer) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        style={{ color: "#666", fontFamily: "Inter, sans-serif", fontSize: 12 }}
      >
        No final answer yet
      </div>
    );
  }
  return (
    <div
      className="flex-1 overflow-auto p-4 streamdown"
      style={{
        color: "#d4d4d4",
        fontFamily: "Inter, sans-serif",
        fontSize: 13,
        lineHeight: "20px",
      }}
    >
      <Streamdown>{answer}</Streamdown>
    </div>
  );
}
