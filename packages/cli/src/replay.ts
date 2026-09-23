import {
  decideGate,
  decidePulse,
  decideSanitize,
  decideSteer,
  decideVerify,
  type Answer,
  type JournalEvent,
  type Policy,
} from "@brainstem/core";

export interface ReplayChange {
  reflex: string;
  subject: string;
  was: string;
  now: string;
  reasons: string[];
}

export interface ReplayReport {
  /** Decisions that were actually re-decided from a resolved judgment's recorded answers. */
  total: number;
  unchanged: number;
  changed: ReplayChange[];
  /** No judgmentId at all — a static-floor verdict, never a Jev judgment. Never replayed. */
  staticOnly: number;
  /** Had a judgmentId, but could not be replayed: no known decider (select/focus) or unresolved reflex/answers. */
  unsupported: number;
  unsupportedReasons: Record<string, number>;
}

const DECIDERS: Record<string, (answers: Record<string, Answer>, policy: Policy) => { action?: string; tier?: string; reasons: string[] }> =
  {
    gate: (answers, policy) => decideGate(answers, policy),
    sanitize: (answers, policy) => decideSanitize(answers, policy),
    verify: (answers, policy) => decideVerify(answers, policy),
    pulse: (answers, policy) => decidePulse(answers, policy),
    steer: (answers, policy) => {
      const d = decideSteer(answers, policy);
      return { action: d.tier, reasons: d.reasons };
    },
  };

// select/focus decisions cannot be genuinely replayed with today's journal
// schema: decideSelect/decideFocus need the full capability catalog or
// section manifest (bitLength, catalogHash, index-to-id mapping) to
// reconstruct a CapabilityBitmap, and only the current batch's candidate
// descriptors are recorded in a reflex event's state — not the full catalog.
// A catalog/manifest-snapshot journal event is a real prerequisite for this,
// not something to improvise here. Until it exists, these decisions are
// reported as visibly unsupported rather than silently dropped.
const NO_CATALOG_REFLEXES: Record<string, string> = {
  select: "select: catalog not recorded",
  focus: "focus: manifest not recorded",
};

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function replayJournal(events: JournalEvent[], policy: Policy): ReplayReport {
  const report: ReplayReport = {
    total: 0,
    unchanged: 0,
    changed: [],
    staticOnly: 0,
    unsupported: 0,
    unsupportedReasons: {},
  };

  // Answers are resolved strictly by judgmentId. There is no fallback to "the
  // most recently seen reflex of this type" — that heuristic can silently
  // attribute a stale, unrelated judgment's answers to a decision that was
  // never actually sent to Jev (a static-floor verdict has no judgmentId at
  // all), which is exactly what stable journal IDs exist to prevent.
  const answersByJudgment = new Map<string, Record<string, Answer>>();
  // Subjects are cosmetic display data only, keyed by judgmentId — never used
  // to resolve which answers apply to a decision.
  const subjectByJudgment = new Map<string, string>();

  for (const event of events) {
    if (event.t !== "reflex") continue;
    if (!event.result) continue;
    answersByJudgment.set(event.judgmentId, event.result.answers);
    subjectByJudgment.set(event.judgmentId, event.subject);
  }

  for (const event of events) {
    if (event.t !== "decision") continue;

    if (event.judgmentId === undefined) {
      report.staticOnly += 1;
      continue;
    }

    const noCatalogReason = NO_CATALOG_REFLEXES[event.reflex];
    if (noCatalogReason !== undefined) {
      report.unsupported += 1;
      bump(report.unsupportedReasons, noCatalogReason);
      continue;
    }

    const answers = answersByJudgment.get(event.judgmentId);
    const decide = DECIDERS[event.reflex];
    if (answers === undefined || decide === undefined) {
      report.unsupported += 1;
      bump(report.unsupportedReasons, answers === undefined ? "missing reflex" : `unknown reflex: ${event.reflex}`);
      continue;
    }

    report.total += 1;
    const redone = decide(answers, policy);
    const now = redone.action ?? redone.tier ?? "unknown";
    if (now === event.action) {
      report.unchanged += 1;
    } else {
      report.changed.push({
        reflex: event.reflex,
        subject: subjectByJudgment.get(event.judgmentId) ?? "?",
        was: event.action,
        now,
        reasons: redone.reasons,
      });
    }
  }

  return report;
}
