import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBitmap, popcount } from "../src/bitmap";
import { ReflexEngine } from "../src/engine";
import { mockSystemOne, noulAnswer } from "../src/providers/mock";
import { policyForTrust } from "../src/policy";
import type { Answer, Question } from "../src/types";
import { loadJournal, openJournal } from "../src/journal";
import {
  batchSections,
  buildFocusQuestions,
  decideFocus,
  decideFocusMode,
  decodeSectionId,
  encodeSectionId,
  FOCUS_BATCH_CHAR_BUDGET,
  FOCUS_MIN_CHARS,
  isExhaustiveTask,
  type FocusDecision,
  type FocusInput,
} from "../src/output-focus";
import { splitIntoSections } from "../src/output-sections";

const POLICY = policyForTrust(0.3);

function manifestFrom(...paragraphs: string[]) {
  return splitIntoSections("art", paragraphs.join("\n\n"));
}

function focusInput(overrides: Partial<FocusInput> = {}): FocusInput {
  const manifest = overrides.manifest ?? manifestFrom("a", "b", "c");
  return {
    task: "did the tests pass",
    command: "npm test",
    outcome: "ok",
    recentFindings: [],
    budgetChars: 10_000,
    manifest,
    ...overrides,
  };
}

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function focusEngineWith(script: (state: unknown, questions: Record<string, Question>) => Record<string, Answer>) {
  const mock = mockSystemOne(script);
  dir = mkdtempSync(join(tmpdir(), "brainstem-focus-"));
  const journalPath = join(dir, "session.ndjson");
  const journal = openJournal(journalPath);
  const engine = new ReflexEngine({ systemOne: mock, journal, policy: POLICY, root: dir });
  return { mock, journalPath, engine };
}

describe("isExhaustiveTask", () => {
  test("matches exhaustive keywords in task", () => {
    const manifest = manifestFrom("a", "b", "c");
    expect(isExhaustiveTask({ task: "count how many tests failed", intent: undefined, manifest })).toBe(true);
    expect(isExhaustiveTask({ task: "show the full output", intent: undefined, manifest })).toBe(true);
  });

  test("fires when the manifest has one or fewer sections", () => {
    const manifest = splitIntoSections("x", "single section");
    expect(isExhaustiveTask({ task: "summarize", intent: undefined, manifest })).toBe(true);
  });

  test("fires when total text length is at or below FOCUS_MIN_CHARS", () => {
    const manifest = splitIntoSections("x", "short");
    expect(isExhaustiveTask({ task: "summarize", intent: undefined, manifest })).toBe(true);
  });

  test("a precision-seeking task ('what exact value...') does NOT trigger the exhaustive bypass", () => {
    // "exact"/"exactly" signals precision, not exhaustiveness — this is the
    // core case Focus exists to help with (find the one relevant fact), not
    // a request to see everything. A regression here previously caused most
    // "give the exact X" tasks to silently fall back to the naive bounded
    // view instead of a real selection.
    const manifest = manifestFrom(
      "alpha section with enough content to avoid the min-chars bypass ".repeat(10),
      "beta section with enough content to avoid the min-chars bypass ".repeat(10),
    );
    expect(isExhaustiveTask({ task: "What exact header value did the server return?", intent: undefined, manifest })).toBe(false);
    expect(isExhaustiveTask({ task: "Give the exact rollback reason.", intent: undefined, manifest })).toBe(false);
  });
});

describe("section id encoding", () => {
  test("round-trips section ids through focus ids", () => {
    expect(encodeSectionId("art:0")).toBe("focus__art_0");
    expect(decodeSectionId("focus__art_0")).toBe("art:0");
    expect(encodeSectionId("cmd:stdout:3")).toBe("focus__cmd_stdout_3");
    expect(decodeSectionId("focus__cmd_stdout_3")).toBe("cmd:stdout:3");
  });
});

describe("buildFocusQuestions", () => {
  test("produces a required relevance noul and an optional contradiction noul per section", () => {
    const manifest = manifestFrom("section text");
    const questions = buildFocusQuestions(manifest.entries);
    expect(Object.keys(questions)).toEqual([encodeSectionId("art:0"), `${encodeSectionId("art:0")}__contradicts`]);
    expect(questions[encodeSectionId("art:0")]!.type).toBe("noul");
    const instructions = (questions[encodeSectionId("art:0")] as import("../src/types").NoulQuestion).instructions;
    expect(instructions).toContain("section text");
    expect(instructions).toContain("necessary evidence");
    const contra = questions[`${encodeSectionId("art:0")}__contradicts`] as import("../src/types").NoulQuestion;
    expect(contra.instructions).toContain("contradicts");
  });

  test("caps section text in questions at 2000 chars without mutating the stored section", () => {
    const manifest = splitIntoSections("x", "x".repeat(5_000));
    const questions = buildFocusQuestions(manifest.entries);
    const instructions = (questions[encodeSectionId("x:0")] as import("../src/types").NoulQuestion).instructions;
    expect(instructions.length).toBeLessThan(2_200);
    expect(manifest.entries[0]!.text.length).toBe(5_000);
  });
});

describe("batchSections", () => {
  test("single candidate whose serialized questions exceed budget still gets its own batch", () => {
    const longId = "a".repeat(3_500);
    const manifest = splitIntoSections(longId, "content");
    const batches = batchSections(manifest.entries, FOCUS_BATCH_CHAR_BUDGET);
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.id).toBe(`${longId}:0`);
  });
});

describe("decideFocus", () => {
  test("selects a section above the relevance threshold and pulls in its dependency", () => {
    const manifest = splitIntoSections("out", "FAIL test:\n  error one\n\nPASS other");
    const header = manifest.entries[0]!;
    const child = manifest.entries[1]!;
    const other = manifest.entries[2]!;

    const answers: Record<string, Answer> = {
      [encodeSectionId(child.id)]: noulAnswer(0.9),
      [encodeSectionId(header.id)]: noulAnswer(0.2),
      [encodeSectionId(other.id)]: noulAnswer(0.1),
    };

    const { selected, sectionReasons } = decideFocus(manifest, manifest.entries, answers, POLICY, 10_000);
    expect(popcount(selected)).toBe(2);
    expect(sectionReasons[child.id]).toEqual({ kind: "selected", score: 0.9 });
    expect(sectionReasons[header.id]).toEqual({ kind: "dependency" });
  });

  test("contradicts_hypothesis answer selects an otherwise-excluded section", () => {
    const manifest = splitIntoSections("out", "alpha\n\nbeta");
    const a = manifest.entries[0]!;
    const b = manifest.entries[1]!;
    const answers: Record<string, Answer> = {
      [encodeSectionId(b.id)]: noulAnswer(0.4),
      [`${encodeSectionId(b.id)}__contradicts`]: noulAnswer(0.9),
      [encodeSectionId(a.id)]: noulAnswer(0.9),
    };

    const { selected, sectionReasons } = decideFocus(manifest, manifest.entries, answers, POLICY, 10_000);
    expect(sectionReasons[b.id]).toEqual({ kind: "selected", score: 0.4 });
    expect(popcount(selected)).toBe(2);
  });

  test("marks the excluded tail as over_budget when the budget is exhausted", () => {
    const manifest = splitIntoSections("out", ["a", "b", "c"].join("\n\n"));
    const answers: Record<string, Answer> = {
      [encodeSectionId("out:0")]: noulAnswer(0.9),
      [encodeSectionId("out:1")]: noulAnswer(0.8),
      [encodeSectionId("out:2")]: noulAnswer(0.7),
    };

    const { sectionReasons } = decideFocus(manifest, manifest.entries, answers, POLICY, 1);
    expect(sectionReasons["out:0"]).toEqual({ kind: "selected", score: 0.9 });
    expect(sectionReasons["out:1"]).toEqual({ kind: "over_budget", score: 0.8 });
    expect(sectionReasons["out:2"]).toEqual({ kind: "over_budget", score: 0.7 });
  });

  test("marks a missing answer as unevaluated", () => {
    const manifest = splitIntoSections("out", "alpha\n\nbeta");
    const answers: Record<string, Answer> = {
      [encodeSectionId("out:0")]: noulAnswer(0.9),
    };
    const { sectionReasons } = decideFocus(manifest, manifest.entries, answers, POLICY, 10_000);
    expect(sectionReasons["out:1"]).toEqual({ kind: "unevaluated" });
  });

  test("all sections below threshold with no contradiction flips yields compute_or_retrieve", () => {
    const manifest = splitIntoSections("out", "alpha\n\nbeta");
    const answers: Record<string, Answer> = {
      [encodeSectionId("out:0")]: noulAnswer(0.2),
      [encodeSectionId("out:1")]: noulAnswer(0.3),
    };
    const { selected, evaluated } = decideFocus(manifest, manifest.entries, answers, POLICY, 10_000);
    expect(popcount(selected)).toBe(0);
    expect(popcount(evaluated)).toBe(2);
    expect(decideFocusMode(evaluated, selected, manifest)).toBe("compute_or_retrieve");
  });
});

function assertFullModeIgnoresSelected(decision: FocusDecision) {
  // Contract under test: mode alone governs the view. This helper intentionally
  // does not inspect popcount(selected) so the suite cannot start relying on an
  // empty selected bitmap as the mechanism for full mode.
  expect(decision.mode).toBe("full");
  expect(decision.status).toBe("unavailable");
}

describe("ReflexEngine.focus", () => {
  test("exhaustive bypass on keyword makes zero SystemOne calls and returns full mode", async () => {
    const manifest = manifestFrom(...Array.from({ length: 20 }, (_, i) => `paragraph ${i}`));
    const { engine, mock } = focusEngineWith(() => ({}));
    const decision = await engine.focus(focusInput({ task: "count how many tests failed", manifest }));
    expect(decision.mode).toBe("full");
    expect(decision.status).toBe("ok");
    expect(decision.batches).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });

  test("exhaustive bypass on small manifest makes zero SystemOne calls", async () => {
    const manifest = splitIntoSections("x", "small");
    const { engine, mock } = focusEngineWith(() => ({}));
    const decision = await engine.focus(focusInput({ manifest }));
    expect(decision.mode).toBe("full");
    expect(mock.calls).toHaveLength(0);
  });

  test("selects a section and journals one reflex plus decision per batch", async () => {
    const manifest = manifestFrom(
      "alpha section with enough text to avoid the exhaustive small-manifest bypass ".repeat(7).trim(),
      "beta section with enough text to avoid the exhaustive small-manifest bypass ".repeat(7).trim(),
    );
    const { engine, journalPath, mock } = focusEngineWith((_state, questions) => {
      const answers: Record<string, Answer> = {};
      for (const id of Object.keys(questions)) {
        answers[id] = noulAnswer(0.9);
      }
      return answers;
    });

    const decision = await engine.focus(focusInput({ manifest }));
    expect(decision.status).toBe("ok");
    expect(decision.batches).toBe(1);
    expect(decision.mode).toBe("select");
    expect(mock.calls).toHaveLength(1);

    const events = loadJournal(journalPath);
    const reflexes = events.filter((e: { t: string; reflex?: string }) => e.t === "reflex" && e.reflex === "focus");
    const decisions = events.filter((e: { t: string; reflex?: string }) => e.t === "decision" && e.reflex === "focus");
    expect(reflexes).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.t === "decision" && decisions[0].judgmentId).toBe(
      reflexes[0]?.t === "reflex" ? reflexes[0].judgmentId : undefined,
    );
  });

  test("Jev unavailable returns full mode and status unavailable", async () => {
    const manifest = manifestFrom(
      "alpha section with enough text to avoid the exhaustive small-manifest bypass ".repeat(20).trim(),
      "beta section with enough text to avoid the exhaustive small-manifest bypass ".repeat(20).trim(),
    );
    mockSystemOne.failing("focus down");
    dir = mkdtempSync(join(tmpdir(), "brainstem-focus-fail-"));
    const journalPath = join(dir, "session.ndjson");
    const journal = openJournal(journalPath);
    const engine = new ReflexEngine({
      systemOne: mockSystemOne.failing("focus down"),
      journal,
      policy: POLICY,
      root: dir,
    });

    const decision = await engine.focus(focusInput({ manifest }));
    assertFullModeIgnoresSelected(decision);
  });

  test("partial batch failure keeps earlier batch scores and reports partial", async () => {
    const manifest = manifestFrom(
      ...Array.from({ length: 3 }, (_, i) =>
        `section ${i} with enough text to force its own batch because each serialized pair of questions exceeds the character budget`.padEnd(
          3_000,
          " ",
        ),
      ),
    );
    let call = 0;
    const { engine, mock } = focusEngineWith((_state, questions) => {
      call++;
      if (call === 1) {
        const answers: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) {
          answers[id] = noulAnswer(0.9);
        }
        return answers;
      }
      throw new Error("batch 2 unavailable");
    });

    const decision = await engine.focus(focusInput({ manifest, budgetChars: 10_000 }));
    expect(decision.status).toBe("partial");
    expect(decision.batches).toBeGreaterThanOrEqual(2);
    expect(mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(decision.scores).length).toBeGreaterThan(0);
  });
});
