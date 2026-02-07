import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { discoverSkills, formatSkillsPrompt } from "../skills";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skills-test-"));

  // Valid skill
  const validSkill = join(tempDir, "my-skill");
  await mkdir(validSkill);
  await writeFile(
    join(validSkill, "SKILL.md"),
    `---
name: my-skill
description: Does something useful for testing.
---

# My Skill

Instructions go here.
`,
  );

  // Another valid skill
  const anotherSkill = join(tempDir, "data-analysis");
  await mkdir(anotherSkill);
  await writeFile(
    join(anotherSkill, "SKILL.md"),
    `---
name: data-analysis
description: Analyzes datasets and generates reports.
---

# Data Analysis

More instructions.
`,
  );

  // Invalid: missing SKILL.md
  const noSkillMd = join(tempDir, "no-skill-md");
  await mkdir(noSkillMd);
  await writeFile(join(noSkillMd, "README.md"), "not a skill");

  // Invalid: missing frontmatter
  const noFrontmatter = join(tempDir, "no-frontmatter");
  await mkdir(noFrontmatter);
  await writeFile(join(noFrontmatter, "SKILL.md"), "# Just markdown, no frontmatter\n");

  // Invalid: missing description
  const missingDesc = join(tempDir, "missing-desc");
  await mkdir(missingDesc);
  await writeFile(
    join(missingDesc, "SKILL.md"),
    `---
name: missing-desc
---

# Missing Description
`,
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true });
});

describe("discoverSkills", () => {
  it("discovers valid skills in a directory", async () => {
    const skills = await discoverSkills([tempDir]);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["data-analysis", "my-skill"]);
  });

  it("extracts name and description from frontmatter", async () => {
    const skills = await discoverSkills([tempDir]);
    const mySkill = skills.find((s) => s.name === "my-skill");
    expect(mySkill).toBeDefined();
    expect(mySkill!.description).toBe("Does something useful for testing.");
  });

  it("includes absolute path to skill directory", async () => {
    const skills = await discoverSkills([tempDir]);
    const mySkill = skills.find((s) => s.name === "my-skill");
    expect(mySkill!.path).toBe(join(tempDir, "my-skill"));
  });

  it("skips directories without SKILL.md", async () => {
    const skills = await discoverSkills([tempDir]);
    expect(skills.find((s) => s.name === "no-skill-md")).toBeUndefined();
  });

  it("skips skills with missing frontmatter", async () => {
    const skills = await discoverSkills([tempDir]);
    expect(skills.find((s) => s.name === "no-frontmatter")).toBeUndefined();
  });

  it("skips skills with missing required fields", async () => {
    const skills = await discoverSkills([tempDir]);
    expect(skills.find((s) => s.name === "missing-desc")).toBeUndefined();
  });

  it("returns empty array for empty directories list", async () => {
    const skills = await discoverSkills([]);
    expect(skills).toEqual([]);
  });

  it("returns empty array for non-existent directory", async () => {
    const skills = await discoverSkills(["/tmp/does-not-exist-skills-test"]);
    expect(skills).toEqual([]);
  });

  it("merges skills from multiple directories", async () => {
    const secondDir = await mkdtemp(join(tmpdir(), "skills-test2-"));
    const extraSkill = join(secondDir, "extra-skill");
    await mkdir(extraSkill);
    await writeFile(
      join(extraSkill, "SKILL.md"),
      `---
name: extra-skill
description: An extra skill from another directory.
---

# Extra
`,
    );

    try {
      const skills = await discoverSkills([tempDir, secondDir]);
      const names = skills.map((s) => s.name).sort();
      expect(names).toContain("my-skill");
      expect(names).toContain("extra-skill");
    } finally {
      await rm(secondDir, { recursive: true });
    }
  });
});

describe("formatSkillsPrompt", () => {
  it("formats skills as XML", () => {
    const xml = formatSkillsPrompt([
      { name: "my-skill", description: "Does things.", path: "/path/to/my-skill" },
    ]);
    expect(xml).toContain("<available_skills>");
    expect(xml).toContain("</available_skills>");
    expect(xml).toContain("<name>my-skill</name>");
    expect(xml).toContain("<description>Does things.</description>");
    expect(xml).toContain("<location>/path/to/my-skill/SKILL.md</location>");
  });

  it("formats multiple skills", () => {
    const xml = formatSkillsPrompt([
      { name: "skill-a", description: "First.", path: "/a" },
      { name: "skill-b", description: "Second.", path: "/b" },
    ]);
    expect(xml).toContain("<name>skill-a</name>");
    expect(xml).toContain("<name>skill-b</name>");
  });

  it("returns empty string for no skills", () => {
    expect(formatSkillsPrompt([])).toBe("");
  });
});
