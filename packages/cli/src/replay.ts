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
  total: number;
  unchanged: number;
  changed: ReplayChange[];
}

const DECIDERS: Record<string, (answers: Record<string, Answer>, policy: Policy) => { action?: string; tier?: string; reasons: string[] }> = {
  gate: (answers, policy) => decideGate(answers, policy),
  sanitize: (answers, policy) => decideSanitize(answers, policy),
  verify: (answers, policy) => decideVerify(answers, policy),
  pulse: (answers, policy) => decidePulse(answers, policy),
  steer: (answers, policy) => {
    const d = decideSteer(answers, policy);
    return { action: d.tier, reasons: d.reasons };
  },
};

export function replayJournal(events: JournalEvent[], policy: Policy): ReplayReport {
  const report: ReplayReport = { total: 0, unchanged: 0, changed: [] };
  const lastAnswers = new Map<string, Record<string, Answer>>();
  const lastSubjects = new Map<string, string>();
  let lastReflex = "";

  for (const event of events) {
    if (event.t === "reflex") {
      lastAnswers.set(event.reflex, event.result.answers);
      lastSubjects.set(event.reflex, event.subject);
      lastReflex = event.reflex;
      continue;
    }
    if (event.t !== "decision") continue;

    const decide = DECIDERS[event.reflex];
    const answers = lastAnswers.get(event.reflex) ?? lastAnswers.get(lastReflex);
    if (!decide || !answers) continue;

    report.total += 1;
    const redone = decide(answers, policy);
    const now = redone.action ?? redone.tier ?? "unknown";
    if (now === event.action) {
      report.unchanged += 1;
    } else {
      report.changed.push({
        reflex: event.reflex,
        subject: lastSubjects.get(event.reflex) ?? "?",
        was: event.action,
        now,
        reasons: redone.reasons,
      });
    }
  }

  return report;
}
