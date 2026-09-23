import { describe, expect, test } from "vitest";
import { computeActive, toIds } from "@brainstem/core";
import { BASELINE_TOOL_IDS, CapabilityRegistry } from "../src/capabilities/registry";

describe("CapabilityRegistry", () => {
  test("registers the five baseline tools with real descriptions", () => {
    const registry = new CapabilityRegistry();
    const catalog = registry.snapshot();
    expect(catalog.entries.map((d) => d.id)).toEqual([...BASELINE_TOOL_IDS].sort());
    const byId = new Map(catalog.entries.map((d) => [d.id, d] as const));
    expect(byId.get("tool:bash")!.description).toMatch(/shell command/);
    expect(byId.get("tool:read")!.description).toMatch(/file/);
    expect(byId.get("tool:write")!.description).toMatch(/file/);
    expect(byId.get("tool:grep")!.description).toMatch(/regular expression/);
    expect(byId.get("tool:glob")!.description).toMatch(/glob/);
    for (const d of catalog.entries) {
      expect(d.kind).toBe("tool");
      expect(d.alwaysAvailable).toBe(true);
      expect(d.contentHash).toMatch(/^[\da-f]{64}$/);
    }
  });

  test("workingSet starts baseline-active with empty explicit selection", () => {
    const registry = new CapabilityRegistry();
    const ws = registry.workingSet();
    expect(toIds(ws.baseline, registry.snapshot().entries)).toEqual([...BASELINE_TOOL_IDS].sort());
    expect(toIds(ws.explicit, registry.snapshot().entries)).toEqual([]);
    expect(toIds(ws.active, registry.snapshot().entries)).toEqual([...BASELINE_TOOL_IDS].sort());
  });

  test("explicit selection activates tools and fingerprint is stable", () => {
    const registry = new CapabilityRegistry();
    expect(registry.catalogFingerprint()).toBe(registry.snapshot().catalogHash);
    registry.setExplicit(["tool:read"]);
    const ws = registry.workingSet();
    expect(toIds(ws.explicit, registry.snapshot().entries)).toEqual(["tool:read"]);
    const { result } = registry.evaluate();
    expect(result.unmetExplicit).toEqual([]);
    expect(toIds(result.active, registry.snapshot().entries)).toEqual([...BASELINE_TOOL_IDS].sort());
  });

  test("unmet explicit reported when a selected skill is unavailable", () => {
    const registry = new CapabilityRegistry();
    registry.register(
      {
        id: "skill:deploy",
        kind: "skill",
        version: "1.0.0",
        description: "Deploy the project.",
        requires: ["tool:deploy"],
        alwaysAvailable: false,
      },
      { run: () => "deployed" },
    );
    registry.register(
      {
        id: "tool:deploy",
        kind: "tool",
        version: "1.0.0",
        description: "Deploy via CI.",
        alwaysAvailable: false,
      },
      null,
    );
    registry.markAvailability("tool:deploy", false);
    registry.setExplicit(["skill:deploy"]);
    const { catalog, result } = registry.evaluate();
    expect(result.unmetExplicit).toEqual(["skill:deploy"]);
    expect(toIds(result.active, catalog.entries)).toEqual([...BASELINE_TOOL_IDS].sort());
  });

  test("snapshotDescriptors reflects registrations and markAvailability defaults to available", () => {
    const registry = new CapabilityRegistry();
    registry.register(
      {
        id: "skill:debug",
        kind: "skill",
        version: "0.2.0",
        description: "Frontend debugging playbook.",
        alwaysAvailable: false,
      },
      { steps: [] },
    );
    const descriptors = registry.snapshotDescriptors();
    expect(descriptors.map((d) => d.id)).toContain("skill:debug");
    expect(registry.workingSet().available.bitLength).toBe(descriptors.length);
    registry.markAvailability("skill:debug", false);
    const ws = registry.workingSet();
    const catalog = registry.snapshot();
    expect(toIds(ws.available, catalog.entries)).not.toContain("skill:debug");
    expect(computeActive(catalog, ws).unmetExplicit).toEqual([]);
  });

  test("rejects unknown ids in explicit selection and duplicate registration", () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.setExplicit(["tool:nope"])).toThrow(/unknown capability/);
    expect(() => registry.register({ id: "tool:bash", kind: "tool", version: "1", description: "dup" }, null)).toThrow(
      /already registered/,
    );
  });

  test("attachImpl throws on unknown id, double attach, and is visible via impl", () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.attachImpl("tool:nope", { run: () => "" })).toThrow(/unknown capability/);
    registry.attachImpl("tool:bash", { run: () => "" });
    expect(() => registry.attachImpl("tool:bash", { run: () => "" })).toThrow(/already has an impl/);
    expect(registry.impl("tool:bash")).toEqual({ run: expect.any(Function) });
  });

  test("registerSkill stores instructions and descriptor", () => {
    const registry = new CapabilityRegistry();
    registry.registerSkill({
      descriptor: {
        id: "skill:test",
        kind: "skill",
        version: "1.0.0",
        description: "A test skill.",
        useWhen: [],
        avoidWhen: [],
        requires: [],
        alwaysAvailable: false,
        contentHash: "abc",
      },
      instructions: "Do the thing.",
    });
    expect(registry.instructionsFor("skill:test")).toBe("Do the thing.");
    expect(registry.impl("skill:test")).toBeNull();
  });

  test("pin/unpin/pinnedIds round-trip and unknown id throws", () => {
    const registry = new CapabilityRegistry();
    registry.pin(["tool:read"]);
    expect(registry.pinnedIds()).toEqual(["tool:read"]);
    registry.pin(["tool:write"]);
    expect(registry.pinnedIds().sort()).toEqual(["tool:read", "tool:write"]);
    registry.unpin(["tool:read"]);
    expect(registry.pinnedIds()).toEqual(["tool:write"]);
    expect(() => registry.pin(["tool:nope"])).toThrow(/unknown capability/);
  });

  test("workingSet merges registry pins into computeActive opts", () => {
    const registry = new CapabilityRegistry();
    registry.register({ id: "skill:extra", kind: "skill", version: "1", description: "extra", alwaysAvailable: false }, null);
    registry.pin(["skill:extra"]);
    const ws = registry.workingSet();
    expect(toIds(ws.active, registry.snapshot().entries)).toContain("skill:extra");
  });
});
