import { z } from "zod";
import { readFile, stat } from "fs/promises";
import { extname } from "path";
import type {
  ToolDefinition,
  ToolContext,
  ContentPart,
  ImageContentPart,
  DocumentContentPart,
} from "../types";
import type { FileTime } from "./lib/filetime";

const schema = z.object({
  filePath: z.string().describe("Absolute path to the file to read"),
  offset: z.number().optional().describe("0-based line number to start reading from"),
  limit: z.number().optional().describe("Maximum number of lines to read (default 2000)"),
});

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

const MAX_LINE_LENGTH = 2000;
const DEFAULT_LIMIT = 2000;
const MAX_TEXT_BYTES = 50 * 1024; // 50KB
const MAX_BINARY_BYTES = 5 * 1024 * 1024; // 5MB

function isBinary(buffer: Buffer): boolean {
  // Check first 8KB for null bytes
  const check = buffer.subarray(0, 8192);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

export const readTool: ToolDefinition<typeof schema, ContentPart[]> = {
  name: "read",
  description:
    "Read a file from the filesystem. Returns text with line numbers for code files, " +
    "base64-encoded content for images (png, jpg, gif, webp) and PDFs.",
  schema,
  execute: async ({ filePath, offset = 0, limit = DEFAULT_LIMIT }, ctx) => {
    const { fileTime } = ctx as ToolContext & { fileTime: FileTime };
    const ext = extname(filePath).toLowerCase();

    // Check file exists
    let fileSize: number;
    try {
      const s = await stat(filePath);
      fileSize = s.size;
    } catch {
      return { context: `File not found: ${filePath}` };
    }

    // Handle images
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (fileSize > MAX_BINARY_BYTES) {
        return { context: `Image file exceeds 5MB limit: ${filePath}` };
      }
      const data = await readFile(filePath);
      await fileTime.read(filePath);
      const part: ImageContentPart = {
        type: "image",
        mediaType: MIME_TYPES[ext] || "application/octet-stream",
        data: data.toString("base64"),
      };
      return { context: `Read image: ${filePath}`, result: [part] };
    }

    // Handle PDFs
    if (ext === ".pdf") {
      if (fileSize > MAX_BINARY_BYTES) {
        return { context: `PDF file exceeds 5MB limit: ${filePath}` };
      }
      const data = await readFile(filePath);
      await fileTime.read(filePath);
      const part: DocumentContentPart = {
        type: "document",
        mediaType: "application/pdf",
        data: data.toString("base64"),
      };
      return { context: `Read PDF: ${filePath}`, result: [part] };
    }

    // Handle text files
    const buffer = await readFile(filePath);

    // Check for binary
    if (isBinary(buffer)) {
      return { context: `Cannot read binary file: ${filePath}` };
    }

    const text = buffer.toString("utf-8");
    const allLines = text.split("\n");
    // Remove trailing empty string from split if file ends with newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    const totalLines = allLines.length;
    const sliced = allLines.slice(offset, offset + limit);

    // Truncate long lines and track total bytes
    let totalBytes = 0;
    let truncatedByBytes = false;
    const outputLines: string[] = [];

    for (let i = 0; i < sliced.length; i++) {
      let line = sliced[i]!;
      if (line.length > MAX_LINE_LENGTH) {
        line = line.slice(0, MAX_LINE_LENGTH) + " [truncated]";
      }
      const lineNum = offset + i + 1; // 1-based display
      const formatted = `${String(lineNum).padStart(4)} | ${line}`;
      totalBytes += formatted.length;
      if (totalBytes > MAX_TEXT_BYTES) {
        truncatedByBytes = true;
        break;
      }
      outputLines.push(formatted);
    }

    const endLine = offset + outputLines.length;
    let output = `<file path="${filePath}" lines="${offset + 1}-${endLine}" total="${totalLines}">\n`;
    output += outputLines.join("\n");
    output += "\n</file>";

    if (truncatedByBytes) {
      output += "\n[Output truncated at 50KB. Use offset/limit to read more.]";
    }

    await fileTime.read(filePath);
    return { context: output };
  },
};
