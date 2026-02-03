export type HunkLine =
  | { type: "context"; content: string }
  | { type: "add"; content: string }
  | { type: "remove"; content: string };

export interface Hunk {
  header?: string; // optional context hint after @@
  lines: HunkLine[];
  // Derived for convenience:
  contextLines: string[];
  changes: HunkLine[];
}

export type PatchOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; hunks: Hunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const HUNK_START = "@@";

export function parsePatch(input: string): PatchOp[] {
  const rawLines = input.split("\n");
  // Trim trailing empty lines
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]!.trim() === "") {
    rawLines.pop();
  }

  if (rawLines.length === 0 || rawLines[0]!.trim() !== BEGIN) {
    throw new Error(`Patch must start with "${BEGIN}"`);
  }
  if (rawLines[rawLines.length - 1]!.trim() !== END) {
    throw new Error(`Patch must end with "${END}"`);
  }

  const lines = rawLines.slice(1, -1); // strip Begin/End
  const ops: PatchOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith(ADD_FILE)) {
      const path = line.slice(ADD_FILE.length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("+")) {
        contentLines.push(lines[i]!.slice(1));
        i++;
      }
      if (contentLines.length === 0) {
        throw new Error(`Add File "${path}" has no content lines`);
      }
      ops.push({ type: "add", path, content: contentLines.join("\n") + "\n" });
    } else if (line.startsWith(DELETE_FILE)) {
      const path = line.slice(DELETE_FILE.length).trim();
      ops.push({ type: "delete", path });
      i++;
    } else if (line.startsWith(UPDATE_FILE)) {
      const path = line.slice(UPDATE_FILE.length).trim();
      i++;
      const hunks: Hunk[] = [];

      while (i < lines.length && lines[i]!.startsWith(HUNK_START)) {
        const headerLine = lines[i]!;
        const header = headerLine.length > 2 ? headerLine.slice(2).trim() : undefined;
        i++;

        const hunkLines: HunkLine[] = [];
        while (
          i < lines.length &&
          !lines[i]!.startsWith(HUNK_START) &&
          !lines[i]!.startsWith("*** ")
        ) {
          const l = lines[i]!;
          if (l.startsWith("+")) {
            hunkLines.push({ type: "add", content: l.slice(1) });
          } else if (l.startsWith("-")) {
            hunkLines.push({ type: "remove", content: l.slice(1) });
          } else if (l.startsWith(" ") || l === "") {
            // Line starting with space is context; empty line is also context (empty line in file)
            hunkLines.push({ type: "context", content: l === "" ? "" : l.slice(1) });
          } else {
            // Unknown prefix — treat as context (lenient)
            hunkLines.push({ type: "context", content: l });
          }
          i++;
        }

        if (hunkLines.length === 0) {
          throw new Error(`Update File "${path}" has an empty hunk`);
        }

        hunks.push({
          header: header || undefined,
          lines: hunkLines,
          contextLines: hunkLines.filter((l) => l.type === "context").map((l) => l.content),
          changes: hunkLines.filter((l) => l.type !== "context"),
        });
      }

      if (hunks.length === 0) {
        throw new Error(`Update File "${path}" has no hunks`);
      }

      ops.push({ type: "update", path, hunks });
    } else if (line.trim() === "") {
      i++; // skip blank lines between operations
    } else {
      throw new Error(`Unexpected line at position ${i}: "${line}"`);
    }
  }

  return ops;
}
