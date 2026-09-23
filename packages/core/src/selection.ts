import { createBitmap, getBit, intersection, setBit, type CapabilityBitmap } from "./bitmap";
import type { CapabilityCatalog, CapabilityDescriptor } from "./capabilities";
import type { Policy } from "./policy";
import { noul, type Answer, type Question } from "./types";

function assertMaskFor(catalog: CapabilityCatalog, bm: CapabilityBitmap, name: string): void {
  if (bm.catalogHash !== catalog.catalogHash) {
    throw new Error(`${name}: catalogHash mismatch with catalog`);
  }
  if (bm.bitLength !== catalog.entries.length) {
    throw new Error(`${name}: bitLength ${bm.bitLength} does not match catalog size ${catalog.entries.length}`);
  }
}

export interface SelectableCapability {
  descriptor: CapabilityDescriptor;
  index: number;
}

export interface SelectInput {
  task: string;
  recent: string[];
  catalog: CapabilityCatalog;
  available: CapabilityBitmap;
  baseline: CapabilityBitmap;
  explicit: CapabilityBitmap;
  current: CapabilityBitmap;
  discoveryQuery?: string;
}

export type SelectReason =
  | { kind: "added"; score: number }
  | { kind: "retained"; score: number }
  | { kind: "excluded"; score: number }
  | { kind: "unevaluated" }
  | { kind: "pinned" };

export interface SelectDecision {
  evaluated: CapabilityBitmap;
  recommended: CapabilityBitmap;
  scores: Record<string, number>;
  reasons: Record<string, SelectReason>;
  status: "ok" | "partial" | "unavailable";
  batches: number;
}

export const SELECT_BATCH_CHAR_BUDGET = 6_000;

export function encodeSelectId(capabilityId: string): string {
  return `select__${capabilityId.replace(/:/g, "_")}`;
}

export function decodeSelectId(selectId: string): string {
  if (!selectId.startsWith("select__")) {
    throw new Error(`decodeSelectId: invalid select id "${selectId}"`);
  }
  return selectId.slice("select__".length).replace(/_/g, ":");
}

export function eligibleForSelection(
  catalog: CapabilityCatalog,
  available: CapabilityBitmap,
  baseline: CapabilityBitmap,
  explicit: CapabilityBitmap,
): SelectableCapability[] {
  assertMaskFor(catalog, available, "available");
  assertMaskFor(catalog, baseline, "baseline");
  assertMaskFor(catalog, explicit, "explicit");
  const result: SelectableCapability[] = [];
  for (let i = 0; i < catalog.entries.length; i++) {
    if (getBit(available, i) && !getBit(baseline, i) && !getBit(explicit, i)) {
      result.push({ descriptor: catalog.entries[i]!, index: i });
    }
  }
  return result;
}

export function buildSelectQuestions(candidates: SelectableCapability[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const c of candidates) {
    const id = encodeSelectId(c.descriptor.id);
    const useWhen = c.descriptor.useWhen.join("; ");
    const avoidWhen = c.descriptor.avoidWhen.join("; ");
    questions[id] = noul(
      `Given \`task\` and \`recent\`, would the capability described here help perform the next step? id: \`${c.descriptor.id}\`, description: \`${c.descriptor.description}\`. Use when: \`${useWhen}\`. Avoid when: \`${avoidWhen}\`.`,
    );
  }
  return questions;
}

function selectQuestionSize(candidate: SelectableCapability): number {
  return JSON.stringify(buildSelectQuestions([candidate])).length;
}

export function batchCandidates(candidates: SelectableCapability[], budget: number = SELECT_BATCH_CHAR_BUDGET): SelectableCapability[][] {
  const batches: SelectableCapability[][] = [];
  let current: SelectableCapability[] = [];
  let currentSize = 0;
  for (const candidate of candidates) {
    const size = selectQuestionSize(candidate);
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

export function decideSelect(
  catalog: CapabilityCatalog,
  candidates: SelectableCapability[],
  answers: Record<string, Answer>,
  current: CapabilityBitmap,
  policy: Policy,
): { recommended: CapabilityBitmap; scores: Record<string, number>; reasons: Record<string, SelectReason> } {
  assertMaskFor(catalog, current, "current");
  const recommended = createBitmap(catalog.catalogHash, catalog.entries.length);
  const scores: Record<string, number> = {};
  const reasons: Record<string, SelectReason> = {};
  const add = policy.select.addNoul;
  const retain = policy.select.retainNoul;
  for (const c of candidates) {
    const qid = encodeSelectId(c.descriptor.id);
    const answer = answers[qid];
    if (answer?.type !== "noul") {
      reasons[c.descriptor.id] = { kind: "unevaluated" };
      continue;
    }
    const score = answer.noul;
    scores[c.descriptor.id] = score;
    if (score >= add) {
      setBit(recommended, c.index);
      reasons[c.descriptor.id] = { kind: "added", score };
    } else if (getBit(current, c.index) && score >= retain) {
      setBit(recommended, c.index);
      reasons[c.descriptor.id] = { kind: "retained", score };
    } else {
      reasons[c.descriptor.id] = { kind: "excluded", score };
    }
  }
  return { recommended, scores, reasons };
}

export function buildEvaluatedBitmap(
  catalog: CapabilityCatalog,
  candidates: SelectableCapability[],
  answers: Record<string, Answer>,
): CapabilityBitmap {
  const bm = createBitmap(catalog.catalogHash, catalog.entries.length);
  for (const c of candidates) {
    const qid = encodeSelectId(c.descriptor.id);
    if (answers[qid]?.type === "noul") setBit(bm, c.index);
  }
  return bm;
}

export function buildFallbackDecision(
  catalog: CapabilityCatalog,
  current: CapabilityBitmap,
  available: CapabilityBitmap,
  candidates: SelectableCapability[],
): Omit<SelectDecision, "status" | "batches"> {
  assertMaskFor(catalog, current, "current");
  assertMaskFor(catalog, available, "available");
  const recommended = intersection(current, available);
  const evaluated = createBitmap(catalog.catalogHash, catalog.entries.length);
  const scores: Record<string, number> = {};
  const reasons: Record<string, SelectReason> = {};
  for (const c of candidates) {
    reasons[c.descriptor.id] = { kind: "unevaluated" };
  }
  return { evaluated, recommended, scores, reasons };
}
