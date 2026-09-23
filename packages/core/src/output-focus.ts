import { createBitmap, popcount, setBit, type CapabilityBitmap } from "./bitmap";
import type { ToolStatus } from "./evidence";
import type { Policy } from "./policy";
import { noul, type Answer, type Question } from "./types";
import type { OutputSection, SectionManifest } from "./output-sections";
import { dependencyClosure } from "./output-sections";

export type FocusMode = "full" | "select" | "compute_or_retrieve";

export type FocusSectionReason =
  | { kind: "selected"; score: number }
  | { kind: "dependency" }
  | { kind: "excluded"; score: number }
  | { kind: "over_budget"; score: number }
  | { kind: "unevaluated" };

export interface FocusInput {
  task: string;
  command: string;
  intent?: string;
  outcome: ToolStatus;
  recentFindings: string[];
  manifest: SectionManifest;
  budgetChars: number;
}

export interface FocusDecision {
  /**
   * What the caller should show.
   *
   * `mode` alone governs the presented view. `selected` is only meaningful when
   * `mode === "select"`; under `"full"` or `"compute_or_retrieve"` an empty
   * `selected` bitmap does **not** mean "select nothing". Callers must never
   * wire `selected` through without first checking `mode`.
   */
  mode: FocusMode;
  status: "ok" | "partial" | "unavailable";
  sectionManifestHash: string;
  evaluated: CapabilityBitmap;
  selected: CapabilityBitmap;
  scores: Record<string, number>;
  reasons: string[];
  sectionReasons: Record<string, FocusSectionReason>;
  batches: number;
}

export const FOCUS_MIN_CHARS = 800;
export const FOCUS_BATCH_CHAR_BUDGET = 6_000;

// "exact"/"exactly" is deliberately absent: it signals precision-seeking
// ("what exact value did X return") — the core case Focus exists to help
// with — not exhaustiveness. A task asking for one exact fact still needs
// selective evidence, not the full bounded view. Genuinely exhaustive
// phrasings are already covered by the other terms below.
const EXHAUSTIVE_PATTERN = /\ball\b|\bevery\b|\bcomplete list\b|\bfull output\b|\bhow many\b|\bcount\b/i;

export function isExhaustiveTask(input: Pick<FocusInput, "task" | "intent" | "manifest">): boolean {
  if (EXHAUSTIVE_PATTERN.test(input.task) || EXHAUSTIVE_PATTERN.test(input.intent ?? "")) return true;
  if (input.manifest.entries.length <= 1) return true;
  const total = input.manifest.entries.reduce((sum, s) => sum + s.text.length, 0);
  if (total <= FOCUS_MIN_CHARS) return true;
  return false;
}

export function encodeSectionId(id: string): string {
  return `focus__${id.replace(/:/g, "_")}`;
}

export function decodeSectionId(encoded: string): string {
  if (!encoded.startsWith("focus__")) {
    throw new Error(`decodeSectionId: invalid focus id "${encoded}"`);
  }
  return encoded.slice("focus__".length).replace(/_/g, ":");
}

export function buildFocusQuestions(candidates: readonly OutputSection[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const section of candidates) {
    const id = encodeSectionId(section.id);
    const capped = section.text.slice(0, 2_000);
    questions[id] = noul(
      `Given task, the action command (intent: intent), outcome, and recentFindings, is this section necessary evidence for judging whether the action succeeded or for deciding the next step? Section: \`${capped}\`.`,
    );
    questions[`${id}__contradicts`] = noul(
      `Given task, the action command (intent: intent), outcome, and recentFindings, does this section contain evidence that contradicts the current hypothesis in recentFindings, or evidence that an already-attempted approach failed? Section: \`${capped}\`.`,
    );
  }
  return questions;
}

function focusQuestionSize(candidate: OutputSection): number {
  return JSON.stringify(buildFocusQuestions([candidate])).length;
}

export function batchSections(candidates: readonly OutputSection[], budget: number = FOCUS_BATCH_CHAR_BUDGET): OutputSection[][] {
  const batches: OutputSection[][] = [];
  let current: OutputSection[] = [];
  let currentSize = 0;
  for (const candidate of candidates) {
    const size = focusQuestionSize(candidate);
    if (current.length > 0 && currentSize + size > budget) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(candidate);
    currentSize += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideFocus(
  manifest: SectionManifest,
  candidates: readonly OutputSection[],
  answers: Record<string, Answer>,
  policy: Policy,
  budgetChars: number,
): {
  selected: CapabilityBitmap;
  evaluated: CapabilityBitmap;
  scores: Record<string, number>;
  sectionReasons: Record<string, FocusSectionReason>;
} {
  const indexById = new Map(manifest.entries.map((s, i) => [s.id, i] as const));
  const threshold = policy.focus.relevanceNoul;

  const selected = createBitmap(manifest.catalogHash, manifest.entries.length);
  const evaluated = createBitmap(manifest.catalogHash, manifest.entries.length);
  const scores: Record<string, number> = {};
  const sectionReasons: Record<string, FocusSectionReason> = {};
  const selectedIds = new Set<string>();

  type CandidateResult = { id: string; index: number; score: number; flipped: boolean };
  const qualifying: CandidateResult[] = [];

  for (const section of candidates) {
    const idx = indexById.get(section.id);
    if (idx === undefined) continue;
    const qid = encodeSectionId(section.id);
    const relevance = answers[qid];
    const contradiction = answers[`${qid}__contradicts`];

    const hasRelevance = relevance?.type === "noul";
    const hasContradiction = contradiction?.type === "noul";

    if (hasRelevance) {
      setBit(evaluated, idx);
      const score = relevance.noul;
      scores[section.id] = score;
      const flipped = hasContradiction && contradiction.noul >= threshold && score < threshold;

      if (score >= threshold || flipped) {
        qualifying.push({ id: section.id, index: idx, score, flipped });
      } else {
        sectionReasons[section.id] = { kind: "excluded", score };
      }
    } else if (hasContradiction) {
      // Contradiction alone is recorded as evaluated, but without a relevance
      // score there is no selection basis.
      setBit(evaluated, idx);
      sectionReasons[section.id] = { kind: "unevaluated" };
    } else {
      sectionReasons[section.id] = { kind: "unevaluated" };
    }
  }

  qualifying.sort((a, b) => b.score - a.score);

  let runningSize = 0;
  for (let i = 0; i < qualifying.length; i++) {
    const candidate = qualifying[i]!;
    const closure = dependencyClosure(manifest, [candidate.id]);
    let incremental = 0;
    for (const id of closure) {
      if (!selectedIds.has(id)) {
        const idx = indexById.get(id);
        if (idx !== undefined) {
          incremental += manifest.entries[idx]!.text.length;
        }
      }
    }

    if (runningSize + incremental > budgetChars) {
      for (let j = i; j < qualifying.length; j++) {
        const later = qualifying[j]!;
        sectionReasons[later.id] = { kind: "over_budget", score: later.score };
      }
      break;
    }

    for (const id of closure) {
      const idx = indexById.get(id);
      if (idx !== undefined) {
        setBit(selected, idx);
        selectedIds.add(id);
      }
    }
    runningSize += incremental;
    sectionReasons[candidate.id] = { kind: "selected", score: candidate.score };
  }

  // Pull in required context for every selected section. Dependencies are not
  // re-checked against the character budget: a selected section always travels
  // with its required context. In practice this can exceed `budgetChars` by at
  // most the size of one dependency chain, which is an acceptable bounded
  // tradeoff for keeping the selection semantics simple.
  const finalClosure = dependencyClosure(manifest, [...selectedIds]);
  for (const id of finalClosure) {
    const idx = indexById.get(id);
    if (idx === undefined) continue;
    setBit(selected, idx);
    selectedIds.add(id);
    const existing = sectionReasons[id];
    if (!existing || existing.kind !== "selected") {
      sectionReasons[id] = { kind: "dependency" };
    }
  }

  return { selected, evaluated, scores, sectionReasons };
}

export function decideFocusMode(evaluated: CapabilityBitmap, selected: CapabilityBitmap, _catalog: SectionManifest): FocusMode {
  if (!isEmpty(selected)) return "select";
  if (!isEmpty(evaluated)) return "compute_or_retrieve";
  return "full";
}

function isEmpty(bitmap: CapabilityBitmap): boolean {
  return bitmap.bytes.every((b) => b === 0);
}

export function buildFallbackDecision(manifest: SectionManifest): FocusDecision {
  const empty = createBitmap(manifest.catalogHash, manifest.entries.length);
  return {
    mode: "full",
    status: "unavailable",
    sectionManifestHash: manifest.catalogHash,
    evaluated: empty,
    selected: empty,
    scores: {},
    reasons: ["focus unavailable: preserving full bounded view"],
    sectionReasons: {},
    batches: 0,
  };
}

export function buildExhaustiveDecision(manifest: SectionManifest): FocusDecision {
  const empty = createBitmap(manifest.catalogHash, manifest.entries.length);
  return {
    mode: "full",
    status: "ok",
    sectionManifestHash: manifest.catalogHash,
    evaluated: empty,
    selected: empty,
    scores: {},
    reasons: ["exhaustive task: presenting full bounded view"],
    sectionReasons: {},
    batches: 0,
  };
}

export function assembleFocusDecision(
  manifest: SectionManifest,
  inner: {
    selected: CapabilityBitmap;
    evaluated: CapabilityBitmap;
    scores: Record<string, number>;
    sectionReasons: Record<string, FocusSectionReason>;
  },
  status: FocusDecision["status"],
  batches: number,
): FocusDecision {
  const mode = decideFocusMode(inner.evaluated, inner.selected, manifest);
  return {
    mode,
    status,
    sectionManifestHash: manifest.catalogHash,
    evaluated: inner.evaluated,
    selected: inner.selected,
    scores: inner.scores,
    sectionReasons: inner.sectionReasons,
    reasons: [`mode=${mode}`, `evaluated=${popcount(inner.evaluated)}`, `selected=${popcount(inner.selected)}`, `batches=${batches}`],
    batches,
  };
}
