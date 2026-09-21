#!/usr/bin/env bun
// Live test of the ACTUAL SHIPPED Focus code (engine.focus + presentArtifact,
// the real functions wired into harness.ts's afterToolCall) against RTK —
// makes REAL API calls (12 real Jev calls, small real cost). Not part of
// `bun run test`; run with `bun run eval:focus-vs-rtk`.
//
// The output-focus pilot (experiments/output-focus/) already validated the
// CONCEPT with a standalone experiment script. This reuses that pilot's exact
// real captures, exact tasks, and exact recorded RTK sizes, but runs them
// through the actually-shipped F1/F2 code path instead — the question this
// answers is narrower and more concrete: does the code that actually ships
// reproduce the pilot's advantage, on the pilot's own fixtures?
//
// Grounding is checked by substring match against each case's known-correct
// answer text, not a full downstream model call+grade — cheaper, and exactly
// as informative for "did Focus keep the evidence a correct answer needs."
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ReflexEngine, jevSystemOne, splitIntoSections, openJournal } from "@brainstem/core";
import { presentArtifact } from "../../packages/cli/src/output/present";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "output-focus", "results");

interface Case {
  id: string;
  capture: "tests" | "tsc" | "git" | "search";
  task: string;
  required: string[];
  absent?: boolean;
}

// RTK v0.49.0 stdin-filter sizes for these exact captures, recorded in the
// pilot (experiments/output-focus/results/*.rtk.txt, *.raw.txt). Not re-run
// here — RTK isn't installed in this environment; these are the pilot's own
// measured numbers for the same fixtures used below.
const RTK_CHARS: Record<Case["capture"], number> = { tests: 174, tsc: 2981, git: 196, search: 11290 };
const RAW_CHARS: Record<Case["capture"], number> = { tests: 4830, tsc: 2981, git: 7771, search: 11290 };

function loadCases(): Case[] {
  return JSON.parse(readFileSync(join(RESULTS_DIR, "cases.json"), "utf8"));
}

function loadCapture(capture: Case["capture"]): string {
  return readFileSync(join(RESULTS_DIR, `${capture}.raw.txt`), "utf8");
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set (see brainstem/.env).");
    process.exit(1);
  }

  const cases = loadCases();
  const cwd = mkdtempSync(join(tmpdir(), "brainstem-focus-vs-rtk-"));
  const journal = openJournal(join(cwd, "journal.ndjson"));
  const systemOne = jevSystemOne(new TypeSafeClient());
  const engine = new ReflexEngine({ systemOne, journal, root: cwd });

  console.log("=== Shipped Focus vs RTK, on the pilot's own real captures ===\n");

  const rows: { id: string; capture: string; mode: string; rawChars: number; rtkChars: number; focusChars: number; grounded: boolean | "n/a (negative control)" }[] = [];

  for (const c of cases) {
    const content = loadCapture(c.capture);
    const artifactId = `bench:${c.id}`;
    const manifest = splitIntoSections(artifactId, content);
    const decision = await engine.focus({
      task: c.task,
      command: `${c.capture} output`,
      outcome: "ok",
      recentFindings: [],
      manifest,
      budgetChars: 4000,
    });
    const view = presentArtifact(content, artifactId, { rollout: "on", manifest, decision });

    const grounded = c.absent ? ("n/a (negative control)" as const) : c.required.every((r) => view.text.includes(r));
    rows.push({
      id: c.id,
      capture: c.capture,
      mode: decision.mode,
      rawChars: RAW_CHARS[c.capture],
      rtkChars: RTK_CHARS[c.capture],
      focusChars: view.text.length,
      grounded,
    });

    const groundedLabel = grounded === true ? "GROUNDED" : grounded === false ? "MISSING REQUIRED EVIDENCE" : grounded;
    console.log(
      `[${c.id}] mode=${decision.mode} raw=${RAW_CHARS[c.capture]} rtk=${RTK_CHARS[c.capture]} focus=${view.text.length} ${groundedLabel}`,
    );
  }

  console.log("\n=== Summary ===");
  const totalRaw = rows.reduce((s, r) => s + r.rawChars, 0);
  const totalRtk = rows.reduce((s, r) => s + r.rtkChars, 0);
  const totalFocus = rows.reduce((s, r) => s + r.focusChars, 0);
  const groundedCount = rows.filter((r) => r.grounded === true).length;
  const groundableCount = rows.filter((r) => r.grounded !== "n/a (negative control)").length;
  const missingCount = rows.filter((r) => r.grounded === false).length;

  console.log(`Total chars across all ${rows.length} cases:`);
  console.log(`  raw:   ${totalRaw}`);
  console.log(`  rtk:   ${totalRtk} (${((1 - totalRtk / totalRaw) * 100).toFixed(1)}% reduction vs raw)`);
  console.log(`  focus: ${totalFocus} (${((1 - totalFocus / totalRaw) * 100).toFixed(1)}% reduction vs raw, ${((1 - totalFocus / totalRtk) * 100).toFixed(1)}% smaller than RTK)`);
  console.log(`\nGrounding: ${groundedCount}/${groundableCount} cases kept all required evidence (${missingCount} missing)`);
  console.log("\nThis reuses the pilot's exact real captures/tasks/RTK sizes but runs the");
  console.log("actual shipped engine.focus()/presentArtifact() code, not the standalone");
  console.log("pilot script. It does not re-run a downstream model+grading step — grounding");
  console.log("here means 'the required evidence text survived,' not 'a model answered");
  console.log("correctly from it.'");

  rmSync(cwd, { recursive: true, force: true });
}

main();
