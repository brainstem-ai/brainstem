import {
  ReflexEngine,
  policyForTrust,
  openJournal,
  newId,
  splitIntoSections,
  getBit,
  boundForReview,
  REVIEW_CHAR_CAP,
  type SystemOne,
  type Policy,
  type Journal,
  type GateInput,
  type GateDecision,
  type ObserveToolResultInput,
  type SanitizeDecision,
  type VerifyDecision,
  type FocusInput,
  type FocusMode,
  type AskResult,
  type BoundedText,
} from "@brainstem/core";

export type { SystemOne, GateInput, GateDecision, ObserveToolResultInput, SanitizeDecision, VerifyDecision, FocusMode, AskResult, BoundedText };
export { boundForReview, REVIEW_CHAR_CAP };
export { jevJudge } from "./judges/jev";
export { genericJudge } from "./judges/generic";

export interface ReflexDecisionEvent {
  reflex: "gate" | "sanitize" | "verify" | "focus";
  action: string;
  reasons: string[];
  judgmentId?: string;
}

export interface ReflexesOptions {
  /** The only required option. Any SystemOne implementation works — see jevJudge / genericJudge. */
  judge: SystemOne;
  /** Default: process.cwd(). Used by Gate's static floor path checks. */
  root?: string;
  /**
   * Shallow-merged over policyForTrust(0.3)'s defaults — top-level keys only.
   * Overriding one field of a sub-object (e.g. policy.gate.autoConfidence)
   * requires passing the WHOLE `gate` sub-object; there is no deep merge.
   */
  policy?: Partial<Policy>;
  /** Called after every decision. No journal is created unless this or journalPath is supplied. */
  onDecision?: (event: ReflexDecisionEvent) => void;
  /** When supplied, decisions are ALSO durably appended via @brainstem/core's journal format. */
  journalPath?: string;
}

// Matches packages/cli/src/output/present.ts's FOCUS_PRESENT_BUDGET_CHARS —
// a consumer of this library shouldn't have to know a token/char budget
// exists any more than they should know SectionManifest exists.
const DEFAULT_FOCUS_BUDGET_CHARS = 4_000;

export interface FocusLibraryInput extends Omit<FocusInput, "manifest" | "budgetChars"> {
  content: string;
  artifactId?: string;
  budgetChars?: number;
}

export interface FocusResult {
  mode: FocusMode;
  text: string;
  sectionManifestHash: string;
}

export interface Reflexes {
  gate(input: GateInput): Promise<GateDecision & { result?: AskResult }>;
  observe(input: ObserveToolResultInput): Promise<{ sanitize: SanitizeDecision; verify: VerifyDecision }>;
  focus(input: FocusLibraryInput): Promise<FocusResult>;
}

export function createReflexes(options: ReflexesOptions): Reflexes {
  const journal: Journal = options.journalPath ? openJournal(options.journalPath) : { append() {} };
  const policy: Policy = { ...policyForTrust(0.3), ...options.policy };
  const sessionId = newId("sess");

  const engine = new ReflexEngine({
    systemOne: options.judge,
    journal,
    policy,
    root: options.root ?? process.cwd(),
    makeId: () => newId("j"),
    ids: () => ({ sessionId }),
  });

  const emit = (event: ReflexDecisionEvent): void => options.onDecision?.(event);

  return {
    async gate(input) {
      const decision = await engine.gate(input);
      emit({ reflex: "gate", action: decision.action, reasons: decision.reasons });
      return decision;
    },

    async observe(input) {
      const { sanitize, verify } = await engine.observeToolResult(input);
      emit({ reflex: "sanitize", action: sanitize.action, reasons: sanitize.reasons });
      emit({ reflex: "verify", action: verify.action, reasons: verify.reasons });
      return { sanitize, verify };
    },

    async focus(input) {
      const { content, artifactId, budgetChars, ...rest } = input;
      const manifest = splitIntoSections(artifactId ?? "reflexes:focus", content);
      const decision = await engine.focus({ ...rest, manifest, budgetChars: budgetChars ?? DEFAULT_FOCUS_BUDGET_CHARS });
      emit({ reflex: "focus", action: decision.mode, reasons: decision.reasons });

      if (decision.mode !== "select") {
        // "full" and "compute_or_retrieve" both mean: this library has no
        // separate raw-capture-vs-presented-view concept, so the caller
        // already has `content` — return it unmodified rather than
        // reimplementing packages/cli's naive-truncation fallback, which
        // exists only because that harness separately stores the original.
        return { mode: decision.mode, text: content, sectionManifestHash: decision.sectionManifestHash };
      }

      const selectedText = manifest.entries
        .filter((_, i) => getBit(decision.selected, i))
        .map((s) => s.text)
        .join("\n\n");
      return { mode: decision.mode, text: selectedText || content, sectionManifestHash: decision.sectionManifestHash };
    },
  };
}
