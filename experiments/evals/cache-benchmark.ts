#!/usr/bin/env bun
// P10 cache benchmark — makes REAL API calls (real cost). Not part of `bun run
// test`; run explicitly with `bun run eval:cache-benchmark`.
//
// What this proves, narrowly: an identical repeated judgment skips the Jev
// network round-trip entirely when a cache is configured. It is not a general
// "the harness got N% faster" claim — see experiments/evals/README.md.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { BoundedAnswerCache, ReflexEngine, jevSystemOne, openJournal, type SystemOne } from "@brainstem/core";

function countingProxy(inner: SystemOne): { systemOne: SystemOne; count: () => number } {
  let calls = 0;
  return {
    systemOne: {
      name: inner.name,
      ask: (...args) => {
        calls += 1;
        return inner.ask(...args);
      },
    },
    count: () => calls,
  };
}

async function timeRepeatedSanitizeCall(withCache: boolean): Promise<{ firstMs: number; secondMs: number; jevCalls: number }> {
  const cwd = mkdtempSync(join(tmpdir(), "brainstem-cache-bench-"));
  const journalPath = join(cwd, "journal.ndjson");
  const journal = openJournal(journalPath);
  const { systemOne, count } = countingProxy(jevSystemOne(new TypeSafeClient()));
  const engine = new ReflexEngine({
    systemOne,
    journal,
    root: cwd,
    ...(withCache ? { cache: new BoundedAnswerCache() } : {}),
  });

  const content = "Test run: 12 passed, 0 failed, 0 skipped. All green.";
  const call = () =>
    engine.observeToolResult({
      task: "run the test suite",
      source: "tool:bash",
      actionSummary: "npm test",
      intent: "npm test",
      status: "ok",
      truncated: false,
      content,
    });

  const t0 = performance.now();
  await call();
  const firstMs = performance.now() - t0;

  const t1 = performance.now();
  await call();
  const secondMs = performance.now() - t1;

  rmSync(cwd, { recursive: true, force: true });
  return { firstMs, secondMs, jevCalls: count() };
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set — this script makes real API calls and needs it (see brainstem/.env).");
    process.exit(1);
  }

  console.log("=== P10 cache benchmark ===");
  console.log("Same content, same task, same tool — asked twice, back to back.\n");

  console.log("Without a cache (baseline: both calls hit the network):");
  const without = await timeRepeatedSanitizeCall(false);
  console.log(`  first call:  ${without.firstMs.toFixed(0)}ms, ${without.jevCalls} Jev calls made so far`);
  console.log(`  second call: ${without.secondMs.toFixed(0)}ms (expected: similar to the first — no reuse)`);

  console.log("\nWith a cache (second call should skip the network):");
  const withCache = await timeRepeatedSanitizeCall(true);
  console.log(`  first call:  ${withCache.firstMs.toFixed(0)}ms`);
  console.log(`  second call: ${withCache.secondMs.toFixed(0)}ms (expected: near-zero — served from cache)`);
  console.log(`  total real Jev calls for BOTH requests: ${withCache.jevCalls} (expected: 1, not 2)`);

  const speedup = withCache.firstMs / Math.max(withCache.secondMs, 0.01);
  console.log(`\nSecond-call speedup with cache: ${speedup.toFixed(0)}x`);
  console.log("This demonstrates one thing only: an identical repeated judgment skips the");
  console.log("network round-trip. It is not a general harness-latency benchmark.");
}

main();
