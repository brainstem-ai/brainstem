import { describe, expect, test } from "vitest";
import { BoundedAnswerCache, computeCacheKey } from "../src/cache";
import type { AnswerCacheEntry } from "../src/cache";
import type { AskResult } from "../src/types";

function entryOf(bytesFiller: string): AnswerCacheEntry {
  const result: AskResult = {
    model: "jev-1.13.0",
    latencyMs: 100,
    usage: { inputTokens: 1, outputTokens: 1 },
    answers: { a: { type: "noul", noul: 0.5 } },
  };
  return {
    answers: { a: { type: "noul", noul: 0.5 }, filler: { type: "noul", noul: 0 } as never, _pad: bytesFiller as never },
    result,
    originalJudgmentId: "j_1",
    cachedAt: 0,
  };
}

describe("computeCacheKey", () => {
  test("differs when provider, state, or questions differ", () => {
    const q = { safe: { type: "noul" as const, instructions: "safe?" } };
    const a = computeCacheKey("jev:jev-1.13.0", { task: "x" }, q);
    const b = computeCacheKey("jev:jev-1.13.0-mini", { task: "x" }, q);
    const c = computeCacheKey("jev:jev-1.13.0", { task: "y" }, q);
    const d = computeCacheKey("jev:jev-1.13.0", { task: "x" }, { other: q.safe });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  test("identical for identical inputs regardless of object key insertion order", () => {
    const q = { safe: { type: "noul" as const, instructions: "safe?" } };
    const a = computeCacheKey("jev:x", { task: "x", env: "e" }, q);
    const b = computeCacheKey("jev:x", { env: "e", task: "x" }, q);
    expect(a).toBe(b);
  });
});

describe("BoundedAnswerCache", () => {
  test("round-trips a stored entry", () => {
    const cache = new BoundedAnswerCache();
    const entry = entryOf("x");
    cache.set("k1", entry);
    expect(cache.get("k1")).toEqual(entry);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("evicts the oldest entry once maxEntries is exceeded, and the byte total actually shrinks", () => {
    const cache = new BoundedAnswerCache({ maxEntries: 2, maxBytes: 10_000_000 });
    cache.set("k1", entryOf("a"));
    const sizeAfterOne = cache.bytes;
    cache.set("k2", entryOf("b"));
    cache.set("k3", entryOf("c"));

    expect(cache.size).toBe(2);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k2")).toBeDefined();
    expect(cache.get("k3")).toBeDefined();
    // Two entries of roughly the same size as the first one alone — not
    // "didn't throw," an actual shrink is asserted.
    expect(cache.bytes).toBeLessThan(sizeAfterOne * 3);
    expect(cache.bytes).toBeGreaterThan(0);
  });

  test("a byte bound alone can trigger eviction even under the entry-count limit", () => {
    const small = entryOf("x");
    const approxSize = JSON.stringify(small).length;
    const cache = new BoundedAnswerCache({ maxEntries: 100, maxBytes: Math.floor(approxSize * 1.5) });
    cache.set("k1", entryOf("a"));
    cache.set("k2", entryOf("b"));

    // The byte bound only fits ~1.5 entries — the oldest must be gone despite
    // being well under the 100-entry cap.
    expect(cache.size).toBe(1);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k2")).toBeDefined();
  });

  test("get() refreshes recency — a recently-read entry survives eviction over a stale one", () => {
    const cache = new BoundedAnswerCache({ maxEntries: 2, maxBytes: 10_000_000 });
    cache.set("k1", entryOf("a"));
    cache.set("k2", entryOf("b"));
    cache.get("k1"); // k1 is now the most-recently-used
    cache.set("k3", entryOf("c")); // should evict k2, not k1

    expect(cache.get("k1")).toBeDefined();
    expect(cache.get("k2")).toBeUndefined();
    expect(cache.get("k3")).toBeDefined();
  });

  test("re-setting an existing key does not double-count its bytes", () => {
    const cache = new BoundedAnswerCache();
    cache.set("k1", entryOf("a"));
    const bytesAfterFirst = cache.bytes;
    cache.set("k1", entryOf("a"));
    expect(cache.bytes).toBe(bytesAfterFirst);
    expect(cache.size).toBe(1);
  });
});
