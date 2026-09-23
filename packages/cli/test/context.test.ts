import { describe, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildActiveContext } from "../src/capabilities/context";
import { BASELINE_TOOL_IDS, CapabilityRegistry } from "../src/capabilities/registry";

function dummyTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "dummy",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  };
}

describe("buildActiveContext", () => {
  test("no active skills → instructionBlock and instructionHash undefined", () => {
    const registry = new CapabilityRegistry();
    for (const id of BASELINE_TOOL_IDS) registry.attachImpl(id, dummyTool(id.replace("tool:", "")));
    const ws = registry.workingSet();
    const built = buildActiveContext(registry, ws);
    expect(built.instructionBlock).toBeUndefined();
    expect(built.instructionHash).toBeUndefined();
    expect(built.tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "find_capabilities",
      "glob",
      "grep",
      "read",
      "read_output",
      "search_output",
      "write",
    ]);
  });

  test("one active skill → block contains preamble and skill instructions; hash stable", () => {
    const registry = new CapabilityRegistry();
    registry.registerSkill({
      descriptor: {
        id: "skill:verify",
        kind: "skill",
        version: "1.0.0",
        description: "Run make verify.",
        useWhen: [],
        avoidWhen: [],
        requires: [],
        alwaysAvailable: false,
        contentHash: "abc",
      },
      instructions: "After any change, run `make verify`.",
    });
    registry.pin(["skill:verify"]);

    const ws = registry.workingSet();
    const built1 = buildActiveContext(registry, ws);
    const built2 = buildActiveContext(registry, ws);

    expect(built1.instructionBlock).toContain("The following skill instructions supplement");
    expect(built1.instructionBlock).toContain("## Skill: skill:verify");
    expect(built1.instructionBlock).toContain("After any change, run `make verify`.");
    expect(built1.instructionHash).toMatch(/^[\da-f]{64}$/);
    expect(built1.instructionHash).toBe(built2.instructionHash);
  });

  test("active tool with no attached impl is skipped and warned", () => {
    const registry = new CapabilityRegistry();
    registry.attachImpl("tool:bash", { name: "bash" } as unknown as import("@earendil-works/pi-agent-core").AgentTool);
    const ws = registry.workingSet();
    const warnings: string[] = [];
    const built = buildActiveContext(registry, ws, (msg) => warnings.push(msg));

    expect(built.tools.map((t) => t.name)).toEqual(["bash"]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("find_capabilities") || w.includes("read") || w.includes("write"))).toBe(true);
  });
});
