# Read & Patch Tools Design

Tools for file reading and patch-based file mutation in the LLM gateway agent system.

## Research

Design informed by analysis of:
- **anomalyco/opencode**: ReadTool (offset/limit, FileTime tracking, binary detection), WriteTool (whole-file write, FileTime assert, LSP diagnostics), EditTool (string replacement)
- **openai/codex**: read_file (slice + indentation modes), apply_patch (custom patch grammar with context matching instead of line numbers)

Key takeaway: Codex's patch format uses context-line matching rather than line numbers, avoiding the off-by-one errors common with unified diff. OpenCode's FileTime system prevents overwriting externally modified files. We adopt both ideas.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Read pagination | Offset + limit | Simple, YAGNI on indentation mode |
| Write mechanism | Patch-based (Codex grammar) | Context matching > string replace for ambiguous edits |
| Tool count | Two: `read` + `patch` | AddFile in patch covers new file creation |
| Permissions | Read always allowed, patch needs approval | Reads are non-destructive |
| FileTime checks | Yes | Prevents silent overwrites, essential for multi-agent |
| Binary handling | Images as base64, PDF as base64, reject others | Matches provider intersection (Anthropic + OpenAI) |
| Audio support | No | Only OpenAI supports it, only on specific models |

## Message Types Extension

New content part types to support multipart tool results:

```typescript
type TextContentPart = { type: "text"; text: string }
type ImageContentPart = { type: "image"; mediaType: string; data: string }
type DocumentContentPart = { type: "document"; mediaType: string; data: string }
type ContentPart = TextContentPart | ImageContentPart | DocumentContentPart
```

Message `content` field on `user` and `tool` messages becomes `string | ContentPart[]`. Provider harnesses map these to provider-specific formats.

## Read Tool

**Name:** `read`
**File:** `packages/ai/tools/read.ts`

**Parameters:**
```typescript
z.object({
  filePath: z.string(),
  offset: z.number().optional(),  // 0-based start line
  limit: z.number().optional(),   // default 2000
})
```

**Behavior by file type:**

| File type | Extensions | Action |
|---|---|---|
| Text | anything not below | Read lines with offset/limit, number lines, return as text |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | Base64-encode, return ImageContentPart |
| PDF | `.pdf` | Base64-encode, return DocumentContentPart |
| Other binary | detected via null bytes | Return error |

**Safety & edge cases:**
- File not found: return error
- Truncate lines longer than 2000 chars
- Cap text content at 50KB with truncation notice
- Image/PDF: reject if file exceeds 5MB
- Record `FileTime.read(filePath, mtime)` on every successful read
- No permission relay needed

**Text output format:**
```
<file path="/abs/path/to/file.ts" lines="1-50" total="120">
  1 | import { Hono } from "hono"
  2 | import { cors } from "hono/cors"
  ...
</file>
```

## Patch Tool

**Name:** `patch`
**File:** `packages/ai/tools/patch.ts`

**Parameters:**
```typescript
z.object({
  patch: z.string(),
})
```

**Patch grammar (adopted from Codex):**

```
*** Begin Patch
*** Add File: <path>
+line one
+line two

*** Delete File: <path>

*** Update File: <path>
@@ optional context hint
 context line
-removed line
+added line
 context line

*** End Patch
```

Multiple file operations per patch. Lines prefixed with ` ` (context), `+` (add), `-` (remove). Context matching locates hunks by surrounding lines, not line numbers.

**Execution pipeline:**
1. **Parse** - Validate grammar, extract operations
2. **Validate paths** - Must resolve within allowed directories
3. **FileTime.assert** - For UpdateFile/DeleteFile, verify file was read and unmodified
4. **Permission relay** - Derive permission as `patch <glob>` from common parent directory
5. **Context match** - For each hunk, locate position by matching context lines
6. **Apply** - All operations atomically (all succeed or none apply)
7. **FileTime.update** - Record new mtime for modified files
8. **Return** - Summary of changes

**Edge cases:**
- Context lines don't match: error, tell model to re-read
- Multiple hunks in same file: apply top-to-bottom, adjust offsets
- Empty hunk: reject at parse time
- AddFile when file exists: error
- UpdateFile/DeleteFile when file missing: error

## FileTime System

**File:** `packages/ai/tools/lib/filetime.ts`

Internal utility, not a tool. Invisible to the model.

```typescript
const fileTimes = new Map<string, number>() // filePath -> mtime
```

**Operations:**
- `FileTime.read(filePath)` - Store mtime. Called by read tool and patch tool after success.
- `FileTime.assert(filePath)` - Compare current mtime to stored. Fail if changed or never read.
- `FileTime.withLock(filePath, fn)` - Serialize concurrent operations per file path.

State lives on the orchestrator/session level, shared across agents. Resets per session.

## Provider Harness Changes

Each harness maps `ContentPart[]` to provider-specific format:

**Anthropic:**
- Image -> `{ type: "image", source: { type: "base64", media_type, data } }`
- Document -> `{ type: "document", source: { type: "base64", media_type, data } }`

**OpenAI / OpenRouter:**
- Image -> `{ type: "image_url", image_url: { url: "data:<media_type>;base64,<data>" } }`
- Document -> `{ type: "file", file: { file_data: "data:<media_type>;base64,<data>" } }`

**Zen:** TBD based on format support.

Mapping lives in each harness, not shared.

## Tool Registration

- `read`: no `derivePermission`, always allowed, receives FileTime via tool context
- `patch`: `derivePermission` extracts paths and returns glob pattern, receives FileTime via tool context

Tool context extended: `{ spawn?, fileTime: FileTime }`

## File Layout

**New files:**
```
packages/ai/tools/read.ts
packages/ai/tools/patch.ts
packages/ai/tools/lib/filetime.ts
packages/ai/tools/lib/patch-parser.ts
packages/ai/tools/lib/patch-apply.ts
packages/ai/tools/__tests__/read.test.ts
packages/ai/tools/__tests__/patch.test.ts
packages/ai/tools/lib/__tests__/filetime.test.ts
packages/ai/tools/lib/__tests__/patch-parser.test.ts
packages/ai/tools/lib/__tests__/patch-apply.test.ts
```

**Modified files:**
```
packages/ai/types.ts                        # ContentPart types
packages/ai/harness/providers/anthropic.ts  # ContentPart mapping
packages/ai/harness/providers/openai.ts     # ContentPart mapping
packages/ai/harness/providers/openrouter.ts # ContentPart mapping
packages/ai/harness/providers/zen.ts        # ContentPart mapping
packages/ai/harness/agent.ts               # Pass FileTime via context
packages/ai/orchestrator.ts                # Own FileTime per session
```
