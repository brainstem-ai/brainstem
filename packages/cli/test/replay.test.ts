import { describe, expect, test } from "vitest";
import { replayJournal } from "../src/replay";
import { policyForTrust } from "@brainstem/core";
import type { JournalEvent } from "@brainstem/core";

function gateReflex(answers: Record<string, unknown>): JournalEvent {
  return {
    t: "reflex",
    ts: 1,
    reflex: "gate",
    subject: "npm publish",
    state: {},
    questions: {},
    result: { model: "jev-1.13.0", latencyMs: 200, usage: { inputTokens: 700, outputTokens: 0 }, answers: answers as never },
  };
}

const HIGH_CONF_AUTO = {
  destructive: { type: "score", score: 0, probabilities: {}, confidence: 0.9 },
  touches_credentials: { type: "noul", noul: 0.03 },
  exfiltrates: { type: "noul", noul: 0.02 },
  writes_outside_project: { type: "noul", noul: 0.02 },
  on_task: { type: "noul", noul: 0.95 },
  disposition: { type: "choice", choice: "auto_run", probabilities: { auto_run: 0.95 }, confidence: 0.95 },
};

const MID_CONF_AUTO = {
  ...HIGH_CONF_AUTO,
  disposition: { type: "choice", choice: "auto_run", probabilities: { auto_run: 0.7 }, confidence: 0.7 },
};

describe("replayJournal", () => {
  test("reports unchanged decisions when policy matches", () => {
    const events: JournalEvent[] = [
      { t: "session_start", ts: 0, trust: 0.3 },
      gateReflex(HIGH_CONF_AUTO),
      { t: "decision", ts: 2, reflex: "gate", action: "auto", reasons: ["original"] },
    ];
    const report = replayJournal(events, policyForTrust(0.3));
    expect(report.total).toBe(1);
    expect(report.unchanged).toBe(1);
    expect(report.changed).toHaveLength(0);
  });

  test("flags decisions a stricter policy would flip", () => {
    const events: JournalEvent[] = [
      { t: "session_start", ts: 0, trust: 0.3 },
      gateReflex(MID_CONF_AUTO),
      { t: "decision", ts: 2, reflex: "gate", action: "auto", reasons: ["original"] },
    ];
    const report = replayJournal(events, policyForTrust(0.05));
    expect(report.changed).toHaveLength(1);
    expect(report.changed[0]?.was).toBe("auto");
    expect(report.changed[0]?.now).toBe("ask");
    expect(report.changed[0]?.reasons.join(" ")).toContain("confidence");
  });

  test("re-decides sanitize and verify reflexes", () => {
    const answers = {
      contains_agent_directive: { type: "noul", noul: 0.5 },
      tries_to_override: { type: "noul", noul: 0.1 },
      requests_dangerous_action: { type: "noul", noul: 0.05 },
      severity: { type: "score", score: 0.5, probabilities: {}, confidence: 0.9 },
      satisfies_intent: { type: "noul", noul: 0.9 },
      result_quality: { type: "score", score: 2, probabilities: {}, confidence: 0.9 },
    };
    const events: JournalEvent[] = [
      {
        t: "reflex",
        ts: 1,
        reflex: "sanitize",
        subject: "tool:read",
        state: {},
        questions: {},
        result: { model: "jev-1.13.0", latencyMs: 180, usage: { inputTokens: 500, outputTokens: 0 }, answers: answers as never },
      },
      { t: "decision", ts: 2, reflex: "sanitize", action: "pass", reasons: [] },
      { t: "decision", ts: 3, reflex: "verify", action: "ok", reasons: [] },
    ];
    const report = replayJournal(events, policyForTrust(0.3));
    expect(report.total).toBe(2);
    expect(report.unchanged).toBe(2);
  });

  test("ignores non-reflex events and unmatched decisions", () => {
    const events: JournalEvent[] = [
      { t: "session_start", ts: 0, trust: 0.3 },
      { t: "decision", ts: 1, reflex: "gate", action: "auto", reasons: [] },
      { t: "session_end", ts: 2 },
    ];
    const report = replayJournal(events, policyForTrust(0.3));
    expect(report.total).toBe(0);
  });
});
