import { describe, expect, test } from "vitest";
import { createBitmap, fromIds, getBit, type ReflexEngine, type SelectDecision, type SelectInput } from "@brainstem/core";
import { CapabilityRegistry } from "../src/capabilities/registry";
import { SelectDriver, type SelectTrigger } from "../src/capabilities/select-policy";

function fakeEngine(decider?: (input: SelectInput) => SelectDecision): { engine: ReflexEngine; calls: SelectInput[] } {
  const calls: SelectInput[] = [];
  const engine = {
    select: async (input: SelectInput) => {
      calls.push(input);
      const empty = createBitmap(input.catalog.catalogHash, input.catalog.entries.length);
      return (
        decider?.(input) ?? {
          evaluated: empty,
          recommended: empty,
          scores: {},
          reasons: {},
          status: "ok",
          batches: 0,
        }
      );
    },
  } as unknown as ReflexEngine;
  return { engine, calls };
}

function trigger(reason: SelectTrigger["reason"]): SelectTrigger {
  return { reason };
}

describe("SelectDriver.shouldRefresh", () => {
  test("enforces minRefreshIntervalMs for repeated task_update triggers", async () => {
    const registry = new CapabilityRegistry();
    const { engine } = fakeEngine();
    const driver = new SelectDriver({ registry, engine, minRefreshIntervalMs: 5_000 });
    await driver.refresh({ task: "t", recent: [] }, trigger("task_update"));
    const base = Date.now();
    expect(driver.shouldRefresh(trigger("task_update"), base)).toBe(false);
    expect(driver.shouldRefresh(trigger("task_update"), base + 3_000)).toBe(false);
    expect(driver.shouldRefresh(trigger("task_update"), base + 5_001)).toBe(true);
  });

  test("always allows discovery and manual_refresh", () => {
    const registry = new CapabilityRegistry();
    const { engine } = fakeEngine();
    const driver = new SelectDriver({ registry, engine, minRefreshIntervalMs: 5_000 });
    expect(driver.shouldRefresh(trigger("discovery"), 0)).toBe(true);
    expect(driver.shouldRefresh(trigger("discovery"), 3_000)).toBe(true);
    expect(driver.shouldRefresh(trigger("manual_refresh"), 0)).toBe(true);
    expect(driver.shouldRefresh(trigger("manual_refresh"), 3_000)).toBe(true);
  });
});

describe("SelectDriver.refresh", () => {
  test("catalog hash change discards stale current instead of reusing it", async () => {
    const registry = new CapabilityRegistry();
    const { engine, calls } = fakeEngine((input) => {
      const recommended = createBitmap(input.catalog.catalogHash, input.catalog.entries.length);
      return {
        evaluated: recommended,
        recommended,
        scores: {},
        reasons: {},
        status: "ok",
        batches: 0,
      };
    });
    const driver = new SelectDriver({ registry, engine, minRefreshIntervalMs: 0 });

    await driver.refresh({ task: "t", recent: [] }, trigger("initial"));
    const firstHash = calls[0]!.catalog.catalogHash;
    expect(calls[0]!.current.bitLength).toBe(registry.snapshot().entries.length);

    registry.register({ id: "tool:new", kind: "tool", version: "1.0.0", description: "new tool", alwaysAvailable: true }, null);
    await driver.refresh({ task: "t", recent: [] }, trigger("registry_change"));
    const secondHash = calls[1]!.catalog.catalogHash;
    expect(secondHash).not.toBe(firstHash);
    expect(calls[1]!.current.bitLength).toBe(registry.snapshot().entries.length);
    expect(calls[1]!.current.catalogHash).toBe(secondHash);
    expect(getBit(calls[1]!.current, 0)).toBe(false);
  });
});

describe("CapabilityRegistry.workingSet selected masks", () => {
  test("uses passed evaluated and recommended masks", () => {
    const registry = new CapabilityRegistry();
    registry.register({ id: "skill:opt", kind: "skill", version: "1.0.0", description: "optional skill", alwaysAvailable: true }, null);
    const catalog = registry.snapshot();
    const evaluated = fromIds(["skill:opt"], catalog.entries, catalog.catalogHash);
    const recommended = fromIds(["skill:opt"], catalog.entries, catalog.catalogHash);
    const ws = registry.workingSet({}, { evaluated, recommended });
    expect(
      getBit(
        ws.recommended,
        catalog.entries.findIndex((d) => d.id === "skill:opt"),
      ),
    ).toBe(true);
    expect(
      getBit(
        ws.evaluated,
        catalog.entries.findIndex((d) => d.id === "skill:opt"),
      ),
    ).toBe(true);
  });

  test("zero-arg workingSet is unchanged", () => {
    const registry = new CapabilityRegistry();
    const ws = registry.workingSet();
    expect(ws.evaluated.bytes.every((b) => b === 0)).toBe(true);
    expect(ws.recommended.bytes.every((b) => b === 0)).toBe(true);
  });

  test("throws when selected mask catalogHash does not match snapshot", () => {
    const registry = new CapabilityRegistry();
    const bad = createBitmap("wrong-hash", registry.snapshot().entries.length);
    expect(() => registry.workingSet({}, { evaluated: bad, recommended: bad })).toThrow(/catalogHash mismatch/);
  });
});
