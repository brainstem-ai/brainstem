import { describe, expect, test } from "vitest";
import {
  buildEvaluatedBitmap,
  buildFallbackDecision,
  buildSelectQuestions,
  batchCandidates,
  decideSelect,
  decodeSelectId,
  eligibleForSelection,
  encodeSelectId,
} from "../src/selection";
import { compileCatalog, computeActive, type CapabilityDescriptor } from "../src/capabilities";
import { createBitmap, fromIds, getBit, setBit, toIds } from "../src/bitmap";
import { policyForTrust } from "../src/policy";
import { noulAnswer } from "../src/providers/mock";

const POLICY = policyForTrust(0.3);

function descriptor(id: string, extra: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id,
    kind: "tool",
    version: "1.0.0",
    description: `description for ${id}`,
    useWhen: [`use ${id}`],
    avoidWhen: [`avoid ${id}`],
    requires: [],
    alwaysAvailable: false,
    contentHash: "0",
    ...extra,
  };
}

function catalogOf(...descriptors: CapabilityDescriptor[]) {
  return compileCatalog(descriptors);
}

function bitmapFor(catalog: import("../src/capabilities").CapabilityCatalog, ids: string[]) {
  return fromIds(ids, catalog.entries, catalog.catalogHash);
}

function candidateBitmap(catalog: import("../src/capabilities").CapabilityCatalog, indices: number[]) {
  const bm = createBitmap(catalog.catalogHash, catalog.entries.length);
  for (const i of indices) setBit(bm, i);
  return bm;
}

describe("eligibleForSelection", () => {
  test("includes available capabilities that are not baseline or explicit", () => {
    const catalog = catalogOf(
      descriptor("tool:a", { alwaysAvailable: true }),
      descriptor("tool:b", { alwaysAvailable: true }),
      descriptor("tool:c"),
    );
    const available = bitmapFor(catalog, ["tool:a", "tool:b", "tool:c"]);
    const baseline = bitmapFor(catalog, ["tool:a"]);
    const explicit = bitmapFor(catalog, ["tool:b"]);
    const eligible = eligibleForSelection(catalog, available, baseline, explicit);
    expect(eligible.map((c) => c.descriptor.id)).toEqual(["tool:c"]);
  });

  test("returns empty when everything is baseline or explicit", () => {
    const catalog = catalogOf(descriptor("tool:a", { alwaysAvailable: true }), descriptor("tool:b", { alwaysAvailable: true }));
    const available = bitmapFor(catalog, ["tool:a", "tool:b"]);
    const baseline = bitmapFor(catalog, ["tool:a"]);
    const explicit = bitmapFor(catalog, ["tool:b"]);
    expect(eligibleForSelection(catalog, available, baseline, explicit)).toHaveLength(0);
  });
});

describe("select id encoding", () => {
  test("round-trips capability ids through select ids", () => {
    expect(encodeSelectId("tool:bash")).toBe("select__tool_bash");
    expect(decodeSelectId("select__tool_bash")).toBe("tool:bash");
    expect(encodeSelectId("skill:deploy:prod")).toBe("select__skill_deploy_prod");
    expect(decodeSelectId("select__skill_deploy_prod")).toBe("skill:deploy:prod");
  });
});

describe("buildSelectQuestions", () => {
  test("produces one noul question per candidate with the expected instructions", () => {
    const catalog = catalogOf(descriptor("tool:c", { description: "C tool", useWhen: ["use c"], avoidWhen: ["avoid c"] }));
    const c = { descriptor: catalog.entries[0]!, index: 0 };
    const questions = buildSelectQuestions([c]);
    expect(Object.keys(questions)).toEqual(["select__tool_c"]);
    expect(questions["select__tool_c"]?.type).toBe("noul");
    const instructions = (questions["select__tool_c"] as import("../src/types").NoulQuestion).instructions;
    expect(instructions).toContain("tool:c");
    expect(instructions).toContain("C tool");
    expect(instructions).toContain("use c");
    expect(instructions).toContain("avoid c");
  });
});

describe("decideSelect", () => {
  function setup(ids: string[]) {
    const catalog = catalogOf(...ids.map((id) => descriptor(id)));
    const candidates = ids.map((id, index) => ({ descriptor: catalog.entries[index]!, index }));
    const current = createBitmap(catalog.catalogHash, catalog.entries.length);
    return { catalog, candidates, current };
  }

  test("scores above add threshold are recommended with reason added", () => {
    const { catalog, candidates, current } = setup(["tool:a"]);
    const answers = { select__tool_a: noulAnswer(0.8) };
    const { recommended, scores, reasons } = decideSelect(catalog, candidates, answers, current, POLICY);
    expect(getBit(recommended, 0)).toBe(true);
    expect(scores["tool:a"]).toBe(0.8);
    expect(reasons["tool:a"]).toEqual({ kind: "added", score: 0.8 });
  });

  test("mid-range score for an inactive candidate is excluded", () => {
    const { catalog, candidates, current } = setup(["tool:a"]);
    const answers = { select__tool_a: noulAnswer(0.5) };
    const { recommended, reasons } = decideSelect(catalog, candidates, answers, current, POLICY);
    expect(getBit(recommended, 0)).toBe(false);
    expect(reasons["tool:a"]).toEqual({ kind: "excluded", score: 0.5 });
  });

  test("mid-range score for a currently active candidate is retained", () => {
    const { catalog, candidates, current } = setup(["tool:a"]);
    setBit(current, 0);
    const answers = { select__tool_a: noulAnswer(0.5) };
    const { recommended, reasons } = decideSelect(catalog, candidates, answers, current, POLICY);
    expect(getBit(recommended, 0)).toBe(true);
    expect(reasons["tool:a"]).toEqual({ kind: "retained", score: 0.5 });
  });

  test("missing answer is marked unevaluated and not scored", () => {
    const { catalog, candidates, current } = setup(["tool:a", "tool:b"]);
    const answers = { select__tool_a: noulAnswer(0.8) };
    const { scores, reasons } = decideSelect(catalog, candidates, answers, current, POLICY);
    expect(scores["tool:b"]).toBeUndefined();
    expect(reasons["tool:b"]).toEqual({ kind: "unevaluated" });
  });

  test("evaluated bitmap includes only candidates that received answers", () => {
    const { catalog, candidates } = setup(["tool:a", "tool:b"]);
    const answers = { select__tool_a: noulAnswer(0.8) };
    const evaluated = buildEvaluatedBitmap(catalog, candidates, answers);
    expect(getBit(evaluated, 0)).toBe(true);
    expect(getBit(evaluated, 1)).toBe(false);
  });

  test("fallback never adds anything beyond what current already had", () => {
    const catalog = catalogOf(descriptor("tool:a"), descriptor("tool:b"));
    const current = bitmapFor(catalog, ["tool:a"]);
    const available = bitmapFor(catalog, ["tool:a", "tool:b"]);
    const candidates = eligibleForSelection(catalog, available, createBitmap(catalog.catalogHash, 2), createBitmap(catalog.catalogHash, 2));
    const { recommended, reasons } = buildFallbackDecision(catalog, current, available, candidates);
    expect(toIds(recommended, catalog.entries)).toEqual(["tool:a"]);
    for (const c of candidates) {
      expect(reasons[c.descriptor.id]).toEqual({ kind: "unevaluated" });
    }
  });

  test("recommended-but-dependency-broken capability stays in recommended; computeActive drops it", () => {
    const catalog = catalogOf(
      descriptor("tool:a", { alwaysAvailable: true }),
      descriptor("tool:missing"),
      descriptor("skill:b", { requires: ["tool:missing"] }),
    );
    const available = bitmapFor(catalog, ["tool:a", "skill:b"]);
    const baseline = bitmapFor(catalog, ["tool:a"]);
    const candidates = eligibleForSelection(catalog, available, baseline, createBitmap(catalog.catalogHash, 3));
    const answers = { select__skill_b: noulAnswer(0.9) };
    const { recommended } = decideSelect(catalog, candidates, answers, createBitmap(catalog.catalogHash, 3), POLICY);
    expect(toIds(recommended, catalog.entries)).toEqual(["skill:b"]);
    const { active, dropped } = computeActive(catalog, {
      available,
      baseline,
      explicit: createBitmap(catalog.catalogHash, 3),
      evaluated: buildEvaluatedBitmap(catalog, candidates, answers),
      recommended,
    });
    expect(toIds(active, catalog.entries)).toEqual(["tool:a"]);
    expect(dropped.map((d) => d.id)).toContain("skill:b");
  });
});

describe("batchCandidates", () => {
  test("splits oversized candidate sets into multiple ordered batches", () => {
    const catalog = catalogOf(
      descriptor("tool:a", { description: "a".repeat(4_000) }),
      descriptor("tool:b", { description: "b".repeat(4_000) }),
      descriptor("tool:c", { description: "c".repeat(4_000) }),
    );
    const candidates = catalog.entries.map((d, i) => ({ descriptor: d, index: i }));
    const batches = batchCandidates(candidates, 6_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((c) => c.descriptor.id)).toEqual(["tool:a", "tool:b", "tool:c"]);
  });

  test("single candidate whose question exceeds budget still gets its own batch", () => {
    const catalog = catalogOf(descriptor("tool:huge", { description: "x".repeat(10_000) }));
    const candidates = catalog.entries.map((d, i) => ({ descriptor: d, index: i }));
    const batches = batchCandidates(candidates, 6_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.descriptor.id).toBe("tool:huge");
  });
});
