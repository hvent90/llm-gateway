# Agent Skills Support

Implement the [Agent Skills](https://agentskills.io) open format for LLM Gateway.

## Decisions

- **Activation model:** Filesystem-based. Skills metadata is injected into system prompt; the model reads `SKILL.md` via the existing `read` tool when it wants to activate a skill.
- **Discovery paths:** Config-driven only. Skill directories are passed via `AppConfig` — no default/magic paths.
- **Scope:** Core only. Discovery, frontmatter parsing, system prompt injection. No validation, no `allowed-tools` wiring.

## Design

### Module: `packages/ai/skills.ts`

Two exported functions and a type:

```typescript
interface SkillMetadata {
  name: string
  description: string
  path: string // absolute path to skill directory
}

function discoverSkills(directories: string[]): Promise<SkillMetadata[]>
function formatSkillsPrompt(skills: SkillMetadata[]): string
```

### Discovery (`discoverSkills`)

Given an array of directory paths:
1. For each directory, list subdirectories
2. Check if each subdirectory contains a `SKILL.md` file
3. Parse YAML frontmatter to extract `name` and `description`
4. Return `SkillMetadata` with the absolute path to the skill directory
5. Silently skip invalid entries (missing file, missing fields)

### Prompt formatting (`formatSkillsPrompt`)

Produces XML per the integration spec:

```xml
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extracts text and tables from PDF files...</description>
    <location>/path/to/skills/pdf-processing/SKILL.md</location>
  </skill>
</available_skills>
```

Returns empty string if no skills.

### Config integration

Add optional `skillDirs` to `AppConfig`:

```typescript
interface AppConfig {
  skillDirs?: string[]
}
```

Server startup:
1. `discoverSkills(config.skillDirs ?? [])`
2. `formatSkillsPrompt(skills)` to get XML block
3. Prepend skills prompt to system message when spawning agents

### Testing

`packages/ai/__tests__/skills.test.ts` with real temp directories:
- Valid skill discovery
- Invalid skill skipping (missing SKILL.md, missing frontmatter)
- Frontmatter parsing (name + description extraction)
- XML formatting matches spec
- Empty input returns empty string
