import { describe, expect, test } from "vitest";
import { createBitmap, setBit, type CapabilityBitmap, type SelectDecision } from "@brainstem/core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { makeDiscoveryTool } from "../src/capabilities/discovery";
import { CapabilityRegistry } from "../src/capabilities/registry";
import type { SelectDriver } from "../src/capabilities/select-policy";

function textOf(result: AgentToolResult): string {
  const first = result.content[0];
  return first && "text" in first ? (first.text ?? "") : "";
}

function emptyBitmap(registry: CapabilityRegistry): CapabilityBitmap {
  const catalog = registry.snapshot();
  return createBitmap(catalog.catalogHash, catalog.entries.length);
}

function bitmapWithIds(registry: CapabilityRegistry, ids: string[]): CapabilityBitmap {
  const catalog = registry.snapshot();
  const bm = createBitmap(catalog.catalogHash, catalog.entries.length);
  const indexById = new Map(catalog.entries.map((d, i) => [d.id, i] as const));
  for (const id of ids) {
    const i = indexById.get(id);
    if (i !== undefined) setBit(bm, i);
  }
  return bm;
}

function makeDriver(registry: CapabilityRegistry, decision: SelectDecision): SelectDriver {
  return {
    refresh: async () => decision,
    currentDecision: () => decision,
    clearRecommended: () => {},
  } as unknown as SelectDriver;
}

describe("makeDiscoveryTool", () => {
  test("matching query pins and returns matched ids with descriptions", async () => {
    const registry = new CapabilityRegistry();
    registry.registerSkill({
      descriptor: {
        id: "skill:deploy",
        kind: "skill",
        version: "1.0.0",
        description: "Deploy to production.",
        useWhen: [],
        avoidWhen: [],
        requires: [],
        alwaysAvailable: false,
        contentHash: "abc",
      },
      instructions: "Deploy steps.",
    });

    const decision: SelectDecision = {
      evaluated: bitmapWithIds(registry, ["skill:deploy"]),
      recommended: bitmapWithIds(registry, ["skill:deploy"]),
      scores: { "skill:deploy": 0.9 },
      reasons: { "skill:deploy": { kind: "added", score: 0.9 } },
      status: "ok",
      batches: 1,
    };

    const tool = makeDiscoveryTool({
      registry,
      driver: makeDriver(registry, decision),
      taskText: () => "deploy the app",
      recentActivity: () => [],
    });

    const result = await tool.execute("tc1", { query: "deploy" });
    expect(registry.pinnedIds()).toContain("skill:deploy");
    expect(textOf(result)).toContain("skill:deploy");
    expect(textOf(result)).toContain("Deploy to production.");
  });

  test("query matching nothing returns explicit no-match message", async () => {
    const registry = new CapabilityRegistry();
    const decision: SelectDecision = {
      evaluated: emptyBitmap(registry),
      recommended: emptyBitmap(registry),
      scores: {},
      reasons: {},
      status: "ok",
      batches: 1,
    };

    const tool = makeDiscoveryTool({
      registry,
      driver: makeDriver(registry, decision),
      taskText: () => "do something",
      recentActivity: () => [],
    });

    const result = await tool.execute("tc1", { query: "nonsense" });
    expect(textOf(result)).toBe("no capability in the catalog matches 'nonsense'");
  });

  test("Jev unavailable returns bounded unranked candidate list", async () => {
    const registry = new CapabilityRegistry();
    for (let i = 0; i < 25; i++) {
      registry.registerSkill({
        descriptor: {
          id: `skill:extra-${i}`,
          kind: "skill",
          version: "1.0.0",
          description: `Extra skill ${i}.`,
          useWhen: [],
          avoidWhen: [],
          requires: [],
          alwaysAvailable: false,
          contentHash: `hash${i}`,
        },
        instructions: "",
      });
    }

    const decision: SelectDecision = {
      evaluated: emptyBitmap(registry),
      recommended: emptyBitmap(registry),
      scores: {},
      reasons: {},
      status: "unavailable",
      batches: 0,
    };

    const tool = makeDiscoveryTool({
      registry,
      driver: makeDriver(registry, decision),
      taskText: () => "find something",
      recentActivity: () => [],
    });

    const result = await tool.execute("tc1", { query: "anything" });
    const text = textOf(result);
    expect(text).toContain("Jev is unavailable");
    const lines = text.split("\n").filter((l: string) => l.startsWith("skill:"));
    expect(lines.length).toBe(20);
  });
});
