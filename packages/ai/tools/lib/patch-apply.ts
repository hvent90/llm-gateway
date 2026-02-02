import type { Hunk, HunkLine } from "./patch-parser";

/**
 * Find the starting line index where a hunk's context/remove lines match the file.
 * Returns -1 if no match found.
 */
export function findContextMatch(fileLines: string[], hunk: Hunk): number {
  // Build the sequence of "old" lines (context + remove) that must exist in the file
  const oldLines = hunk.lines
    .filter((l) => l.type === "context" || l.type === "remove")
    .map((l) => l.content);

  if (oldLines.length === 0) {
    // Pure addition — no anchor. Return 0 (prepend) or handle upstream.
    return 0;
  }

  // Slide over fileLines looking for a match
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j] !== oldLines[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }

  return -1;
}

/**
 * Apply a list of hunks to file content. Hunks must be ordered top-to-bottom.
 * Throws if any hunk's context doesn't match.
 */
export function applyHunks(content: string, hunks: Hunk[]): string {
  const hadTrailingNewline = content.endsWith("\n");
  const fileLines = content.split("\n");
  // Remove trailing empty string from split if file ended with newline
  if (hadTrailingNewline && fileLines[fileLines.length - 1] === "") {
    fileLines.pop();
  }

  let offset = 0; // tracks line shift from previous hunk applications

  for (const hunk of hunks) {
    const matchIdx = findContextMatch(fileLines, hunk);
    if (matchIdx === -1) {
      const preview = hunk.lines
        .filter((l) => l.type === "context")
        .slice(0, 3)
        .map((l) => l.content)
        .join(", ");
      throw new Error(
        `Could not find matching context for hunk. Context lines: [${preview}]. ` +
          `Please re-read the file and try again.`,
      );
    }

    // Build replacement: walk hunk lines, keep context and add, skip remove
    const oldLines = hunk.lines
      .filter((l) => l.type === "context" || l.type === "remove")
      .map((l) => l.content);

    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.type === "context" || line.type === "add") {
        newLines.push(line.content);
      }
      // "remove" lines are skipped
    }

    // Splice in the replacement
    fileLines.splice(matchIdx, oldLines.length, ...newLines);

    // Offset adjusts for next hunk (net lines added/removed)
    offset += newLines.length - oldLines.length;
  }

  const result = fileLines.join("\n");
  return hadTrailingNewline ? result + "\n" : result;
}
