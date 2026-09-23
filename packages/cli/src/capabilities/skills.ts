import { hashAction } from "@brainstem/core";
import type { CapabilityDescriptor } from "@brainstem/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInside, resolvePath } from "../paths";

export interface LoadedSkill {
  descriptor: CapabilityDescriptor;
  instructions: string;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  useWhen?: string[];
  avoidWhen?: string[];
}

function normalizeSkillId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "skill"
  );
}

function parseFrontmatter(raw: string, filePath: string): { frontmatter: ParsedFrontmatter; instructions: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, instructions: raw.trim() };
  }

  const lines = trimmed.split("\n");
  if (lines.length < 2 || lines[0]?.trim() !== "---") {
    throw new Error(`malformed frontmatter in ${filePath}: missing opening ---`);
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    throw new Error(`malformed frontmatter in ${filePath}: missing closing ---`);
  }

  const frontmatter: ParsedFrontmatter = {};
  let currentListKey: { key: keyof ParsedFrontmatter; values: string[] } | null = null;

  for (let i = 1; i < endIndex; i++) {
    const line = lines[i]!;
    const trimmedLine = line.trim();
    if (trimmedLine === "") continue;

    const listMatch = /^-\s+(.+)$/.exec(trimmedLine);
    if (listMatch) {
      if (currentListKey === null) {
        throw new Error(`malformed frontmatter in ${filePath}: list item without key at line ${i + 1}`);
      }
      currentListKey.values.push(listMatch[1]!.trim());
      continue;
    }

    if (currentListKey !== null) {
      (frontmatter[currentListKey.key] as string[]) = currentListKey.values;
      currentListKey = null;
    }

    const simpleMatch = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(trimmedLine);
    if (!simpleMatch) {
      throw new Error(`malformed frontmatter in ${filePath}: cannot parse line ${i + 1}: ${line}`);
    }

    const key = simpleMatch[1]!;
    const value = simpleMatch[2]!.trim();

    if (key === "useWhen" || key === "avoidWhen") {
      currentListKey = { key, values: value ? [value] : [] };
    } else {
      if (key === "name") frontmatter.name = value;
      else if (key === "description") frontmatter.description = value;
      else throw new Error(`malformed frontmatter in ${filePath}: unknown key "${key}" at line ${i + 1}`);
    }
  }

  if (currentListKey !== null) {
    (frontmatter[currentListKey.key] as string[]) = currentListKey.values;
  }

  const instructions = lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();
  return { frontmatter, instructions };
}

function validateInsideAllowedRoots(resolved: string, allowedRoots: string[], filePath: string): void {
  if (!allowedRoots.some((root) => isInside(root, resolved))) {
    throw new Error(`skill path outside allowed roots: ${filePath} (${resolved})`);
  }
}

export function loadSkillsFromRoot(root: string, allowedRoots?: string[]): LoadedSkill[] {
  const resolvedRoot = resolvePath(process.cwd(), root);
  const roots = allowedRoots && allowedRoots.length > 0 ? allowedRoots.map((r) => resolvePath(process.cwd(), r)) : [resolvedRoot];
  validateInsideAllowedRoots(resolvedRoot, roots, root);

  let entries: string[];
  try {
    entries = readdirSync(resolvedRoot);
  } catch (err) {
    throw new Error(`cannot read skill root ${root}: ${(err as Error).message}`);
  }

  const byId = new Map<string, { name: string; path: string }>();
  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    const skillDir = join(resolvedRoot, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }

    validateInsideAllowedRoots(skillDir, roots, skillDir);

    const skillPath = join(skillDir, "SKILL.md");
    let raw: string;
    try {
      raw = readFileSync(skillPath, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") continue;
      throw new Error(`cannot read skill file ${skillPath}: ${(err as Error).message}`);
    }

    const { frontmatter, instructions } = parseFrontmatter(raw, skillPath);
    const name = normalizeSkillId(frontmatter.name || entry);
    const id = `skill:${name}`;

    if (byId.has(id)) {
      const first = byId.get(id)!;
      throw new Error(`duplicate skill id "${id}" from ${first.path} and ${skillPath}`);
    }
    byId.set(id, { name, path: skillPath });

    const descriptor: CapabilityDescriptor = {
      id,
      kind: "skill",
      version: "1.0.0",
      description: frontmatter.description ?? "",
      useWhen: frontmatter.useWhen ?? [],
      avoidWhen: frontmatter.avoidWhen ?? [],
      requires: [],
      alwaysAvailable: false,
      contentHash: hashAction({ frontmatter, instructions }),
    };

    skills.push({ descriptor, instructions });
  }

  return skills;
}
