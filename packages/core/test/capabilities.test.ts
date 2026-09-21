import { describe, expect, test } from "vitest";
import {
  CAPCAT_NAMESPACE,
  SECT_NAMESPACE,
  compileCatalog,
  computeActive,
  workingSetFromIds,
  type CapabilityDescriptor,
} from "../src/capabilities";
import { fromIds, getBit, toIds } from "../src/bitmap";
import { createBitmap } from "../src/bitmap";

function desc(overrides: Partial<CapabilityDescriptor> & { id: string }): CapabilityDescriptor {
  return {
    kind: "skill",
    version: "1.0.0",
    description: `descriptor ${overrides.id}`,
    useWhen: [],
    avoidWhen: [],
    requires: [],
    alwaysAvailable: false,
    contentHash: `hash:${overrides.id}`,
    ...overrides,
  };
}

describe("compileCatalog", () => {
  test("rejects duplicate ids", () => {
    expect(() => compileCatalog([desc({ id: "a" }), desc({ id: "a" })])).toThrow(/duplicate/);
  });

  test("rejects unknown dependency ids", () => {
    expect(() => compileCatalog([desc({ id: "a", requires: ["ghost"] })])).toThrow(/unknown id "ghost"/);
  });

  test("rejects dependency cycles (DFS)", () => {
    expect(() =>
      compileCatalog([desc({ id: "a", requires: ["b"] }), desc({ id: "b", requires: ["c"] }), desc({ id: "c", requires: ["a"] })]),
    ).toThrow(/cycle/);
    expect(() => compileCatalog([desc({ id: "a", requires: ["a"] })])).toThrow(/cycle/);
  });

  test("sorts entries by id and is stable across input orderings", () => {
    const ids = ["skill:c", "tool:a", "skill:b"];
    const c1 = compileCatalog(ids.map((id) => desc({ id })));
    const c2 = compileCatalog([...ids].reverse().map((id) => desc({ id })));
    expect(c1.entries.map((d) => d.id)).toEqual(["skill:b", "skill:c", "tool:a"]);
    expect(c2.entries.map((d) => d.id)).toEqual(c1.entries.map((d) => d.id));
    expect(c1.catalogHash).toBe(c2.catalogHash);
    expect(Object.isFrozen(c1.entries)).toBe(true);
  });

  test("namespace separates catalog hashes", () => {
    const descriptors = [desc({ id: "a" })];
    const cap = compileCatalog(descriptors, CAPCAT_NAMESPACE);
    const sect = compileCatalog(descriptors, SECT_NAMESPACE);
    expect(cap.catalogHash).not.toBe(sect.catalogHash);
    expect(compileCatalog(descriptors).catalogHash).toBe(cap.catalogHash);
    expect(compileCatalog(descriptors, "capcat/1").catalogHash).toBe(cap.catalogHash);
  });

  test("empty catalog compiles with bitLength 0 semantics", () => {
    const cat = compileCatalog([]);
    expect(cat.entries).toEqual([]);
    expect(cat.catalogHash.length).toBe(64);
    const ws = workingSetFromIds(cat, {});
    const result = computeActive(cat, ws);
    expect(result.active.bitLength).toBe(0);
    expect(result.unmetExplicit).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});

describe("computeActive", () => {
  function build(descriptors: CapabilityDescriptor[], masks: Parameters<typeof workingSetFromIds>[1]) {
    const catalog = compileCatalog(descriptors);
    return { catalog, ws: workingSetFromIds(catalog, masks) };
  }

  test("dependency closure pulls in requires", () => {
    const descriptors = [
      desc({ id: "skill:fe", requires: ["tool:read"] }),
      desc({ id: "tool:read", alwaysAvailable: true }),
      desc({ id: "tool:write", alwaysAvailable: true }),
    ];
    const { catalog, ws } = build(descriptors, {
      explicit: ["skill:fe"],
      available: ["skill:fe", "tool:read", "tool:write"],
    });
    const result = computeActive(catalog, ws);
    expect(toIds(result.active, catalog.entries).sort()).toEqual(["skill:fe", "tool:read"]);
    expect(result.unmetExplicit).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  test("unavailable dependency drops optional seed and reports unmet explicit", () => {
    const descriptors = [
      desc({ id: "skill:opt", requires: ["tool:ghosted"] }),
      desc({ id: "skill:explicit", requires: ["tool:ghosted"] }),
      desc({ id: "tool:ghosted", alwaysAvailable: false }),
      desc({ id: "tool:solo", alwaysAvailable: true }),
    ];
    const { catalog, ws } = build(descriptors, {
      baseline: ["tool:solo"],
      explicit: ["skill:explicit"],
      recommended: ["skill:opt"],
      available: ["tool:solo", "skill:explicit", "skill:opt"],
    });
    const result = computeActive(catalog, ws);
    expect(toIds(result.active, catalog.entries)).toEqual(["tool:solo"]);
    expect(result.unmetExplicit).toEqual(["skill:explicit"]);
    expect(result.dropped).toEqual([
      { id: "skill:opt", reason: expect.stringContaining('requires "tool:ghosted"') },
    ]);
  });

  test("transitive rejections cascade", () => {
    const descriptors = [
      desc({ id: "a", requires: ["b"] }),
      desc({ id: "b", requires: ["c"] }),
      desc({ id: "c", alwaysAvailable: false }),
    ];
    const { catalog, ws } = build(descriptors, { baseline: ["a"], available: ["a", "b"] });
    const result = computeActive(catalog, ws);
    expect(result.active.bitLength).toBeGreaterThan(0);
    expect(toIds(result.active, catalog.entries)).toEqual([]);
    expect(result.dropped).toEqual([{ id: "a", reason: expect.stringContaining("c") }]);
  });

  test("pinned ids participate and unknown pinned ids are ignored", () => {
    const descriptors = [desc({ id: "tool:solo", alwaysAvailable: true }), desc({ id: "skill:extra" })];
    const { catalog, ws } = build(descriptors, { available: ["tool:solo", "skill:extra"] });
    const withPin = computeActive(catalog, ws, { pinned: ["skill:extra", "ghost"] });
    expect(toIds(withPin.active, catalog.entries).sort()).toEqual(["skill:extra"]);
    const withoutPin = computeActive(catalog, ws);
    expect(toIds(withoutPin.active, catalog.entries)).toEqual([]);
  });

  test("recommended only activates when available", () => {
    const descriptors = [desc({ id: "skill:on" }), desc({ id: "skill:off" })];
    const { catalog, ws } = build(descriptors, { recommended: ["skill:on", "skill:off"], available: ["skill:on"] });
    const result = computeActive(catalog, ws);
    expect(toIds(result.active, catalog.entries)).toEqual(["skill:on"]);
    expect(result.dropped).toEqual([{ id: "skill:off", reason: "unavailable" }]);
  });

  test("masks must match the catalog hash and size", () => {
    const catalogA = compileCatalog([desc({ id: "a" })]);
    const catalogB = compileCatalog([desc({ id: "b" })]);
    const wsA = workingSetFromIds(catalogA, {});
    expect(() => computeActive(catalogB, wsA)).toThrow(/catalogHash mismatch/);
    const bigger = compileCatalog([desc({ id: "a" }), desc({ id: "b" })]);
    const wrongSize = {
      available: createBitmap(bigger.catalogHash, 2),
      baseline: createBitmap(bigger.catalogHash, 2),
      explicit: createBitmap(bigger.catalogHash, 2),
      evaluated: createBitmap(bigger.catalogHash, 1),
      recommended: createBitmap(bigger.catalogHash, 2),
    };
    expect(() => computeActive(bigger, wrongSize)).toThrow(/does not match catalog size/);
  });

  test("evaluated mask is accepted but does not seed activation", () => {
    const descriptors = [desc({ id: "tool:x", alwaysAvailable: true })];
    const { catalog, ws } = build(descriptors, { evaluated: ["tool:x"] });
    const result = computeActive(catalog, ws);
    expect(getBit(result.active, 0)).toBe(false);
  });
});

describe("bitmap/catalog namespace discipline", () => {
  test("fromIds hashes carry the catalog hash, ops enforce it", () => {
    const catalog = compileCatalog([desc({ id: "a" }), desc({ id: "b" })], CAPCAT_NAMESPACE);
    const bm = fromIds(["a"], catalog.entries, catalog.catalogHash);
    expect(bm.catalogHash).toBe(catalog.catalogHash);
  });
});
