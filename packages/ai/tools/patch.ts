import { z } from "zod";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import type { ToolDefinition, ToolContext, ToolPermission } from "../types";
import type { FileTime } from "./lib/filetime";
import { parsePatch, type PatchOp } from "./lib/patch-parser";
import { applyHunks } from "./lib/patch-apply";

const schema = z.object({
  patch: z.string().describe("The patch to apply, using the patch grammar format"),
});

interface PatchToolContext extends ToolContext {
  fileTime: FileTime;
}

/**
 * Extract all file paths from a patch string for permission derivation.
 */
function extractPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

/**
 * Find the longest common directory prefix from a list of paths.
 */
function commonDir(paths: string[]): string {
  if (paths.length === 0) return "**";
  if (paths.length === 1) return dirname(paths[0]) + "/**";

  const dirs = paths.map((p) => dirname(p).split("/"));
  const common: string[] = [];
  for (let i = 0; i < dirs[0].length; i++) {
    if (dirs.every((d) => d[i] === dirs[0][i])) {
      common.push(dirs[0][i]);
    } else {
      break;
    }
  }
  return (common.length > 0 ? common.join("/") : "") + "/**";
}

export const patchTool: ToolDefinition<typeof schema> = {
  name: "patch",
  description:
    "Apply file changes using a patch. Supports creating new files (Add File), " +
    "deleting files (Delete File), and editing existing files (Update File) with " +
    "context-based hunk matching.",
  schema,
  derivePermission: (params): ToolPermission => {
    const patchText = String(params.patch ?? "");
    const paths = extractPaths(patchText);
    const glob = commonDir(paths);
    return { tool: "patch", params: { patch: glob } };
  },
  execute: async ({ patch: patchText }, ctx) => {
    const { fileTime } = ctx as PatchToolContext;

    // Parse
    let ops: PatchOp[];
    try {
      ops = parsePatch(patchText);
    } catch (e) {
      return { context: `Patch parse error: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Validate and apply each operation
    const results: string[] = [];

    for (const op of ops) {
      try {
        if (op.type === "add") {
          if (existsSync(op.path)) {
            return { context: `File already exists: ${op.path}` };
          }
          await mkdir(dirname(op.path), { recursive: true });
          await writeFile(op.path, op.content);
          await fileTime.read(op.path);
          results.push(`Added ${op.path}`);
        } else if (op.type === "delete") {
          await fileTime.assert(op.path);
          await unlink(op.path);
          results.push(`Deleted ${op.path}`);
        } else if (op.type === "update") {
          await fileTime.assert(op.path);
          await fileTime.withLock(op.path, async () => {
            const content = await readFile(op.path, "utf-8");
            const updated = applyHunks(content, op.hunks);
            await writeFile(op.path, updated);
            await fileTime.read(op.path);
          });
          results.push(`Updated ${op.path}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { context: `Patch failed on ${op.path}: ${msg}` };
      }
    }

    return { context: results.join("\n") };
  },
};
