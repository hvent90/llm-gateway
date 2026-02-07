import { readdir, readFile } from "fs/promises";
import { join } from "path";

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

export async function discoverSkills(directories: string[]): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];

  for (const dir of directories) {
    let entries: string[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(dir, entry);
      const skillFile = join(skillDir, "SKILL.md");
      let content: string;
      try {
        content = await readFile(skillFile, "utf-8");
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content);
      if (!fm || !fm.name || !fm.description) continue;

      skills.push({ name: fm.name, description: fm.description, path: skillDir });
    }
  }

  return skills;
}

export function formatSkillsPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) return "";

  const entries = skills
    .map(
      (s) =>
        `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.path}/SKILL.md</location>\n  </skill>`,
    )
    .join("\n");

  return `<available_skills>\n${entries}\n</available_skills>`;
}
