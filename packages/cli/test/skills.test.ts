import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromRoot } from "../src/capabilities/skills";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function newDir(): string {
  dir = mkdtempSync(join(tmpdir(), "brainstem-skills-"));
  return dir;
}

function writeSkill(root: string, name: string, body: string): void {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body, "utf8");
}

describe("loadSkillsFromRoot", () => {
  test("loads a minimal SKILL.md with frontmatter and body", () => {
    const root = newDir();
    writeSkill(
      root,
      "verify",
      `---
name: verify
description: Always run make verify after changes.
useWhen:
  - You have just edited code
  - Tests exist for the project
---
After any file change, run \`make verify\` and report the result.
`,
    );

    const skills = loadSkillsFromRoot(root);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.descriptor.id).toBe("skill:verify");
    expect(skill.descriptor.kind).toBe("skill");
    expect(skill.descriptor.description).toBe("Always run make verify after changes.");
    expect(skill.descriptor.useWhen).toEqual(["You have just edited code", "Tests exist for the project"]);
    expect(skill.descriptor.alwaysAvailable).toBe(false);
    expect(skill.descriptor.contentHash).toMatch(/^[\da-f]{64}$/);
    expect(skill.instructions).toContain("After any file change");
  });

  test("falls back to directory name when name is missing", () => {
    const root = newDir();
    writeSkill(root, "my-skill", "---\n---\nBody here.\n");

    const skill = loadSkillsFromRoot(root)[0]!;
    expect(skill.descriptor.id).toBe("skill:my-skill");
  });

  test("normalizes names to lowercase and hyphenates special characters", () => {
    const root = newDir();
    writeSkill(root, "Skill_Name v2!", "---\nname: Skill_Name v2!\n---\nBody.\n");

    const skill = loadSkillsFromRoot(root)[0]!;
    expect(skill.descriptor.id).toBe("skill:skill-name-v2");
  });

  test("two skills resolving to the same id names both paths", () => {
    const root = newDir();
    writeSkill(root, "foo", "---\nname: same\n---\nA\n");
    writeSkill(root, "bar", "---\nname: same\n---\nB\n");

    expect(() => loadSkillsFromRoot(root)).toThrow(/duplicate skill id "skill:same"/);
    expect(() => loadSkillsFromRoot(root)).toThrow(join(root, "foo"));
    expect(() => loadSkillsFromRoot(root)).toThrow(join(root, "bar"));
  });

  test("rejects a skill root outside allowed roots", () => {
    const root = newDir();
    const allowed = newDir();
    writeSkill(root, "x", "---\n---\nBody\n");

    expect(() => loadSkillsFromRoot(root, [allowed])).toThrow(/outside allowed roots/);
  });

  test("rejects malformed frontmatter missing closing delimiter", () => {
    const root = newDir();
    writeSkill(root, "bad", "---\nname: bad\nBody\n");

    expect(() => loadSkillsFromRoot(root)).toThrow(/missing closing ---/);
    expect(() => loadSkillsFromRoot(root)).toThrow(join(root, "bad", "SKILL.md"));
  });
});
