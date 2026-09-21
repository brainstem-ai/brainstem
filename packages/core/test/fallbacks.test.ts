import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReflexEngine } from "../src/engine";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer } from "../src/providers/mock";
import { loadJournal, openJournal } from "../src/journal";
import { policyForTrust } from "../src/policy";
import { checkBudgets } from "../src/budgets";
import type { Answer, Question, SystemOne } from "../src/types";

const POLICY = policyForTrust(0.3);
const SHORT_DEADLINE_POLICY = { ...POLICY, jev: { ...POLICY.jev, deadlineMs: 25 } };

function gateAnswers(): Record<string, Answer> {
  return {
    destructive: scoreAnswer(0.0, 0.9),
    touches_credentials: noulAnswer(0.05),
    exfiltrates: noulAnswer(0.03),
    on_task: noulAnswer(0.9),
    disposition: choiceAnswer("auto_run", 0.95, { auto_run: 0.95, ask_user: 0.04, deny: 0.01 }),
  };
}

function sanitizeAnswers(): Record<string, Answer> {
  return {
    contains_agent_directive: noulAnswer(0.02),
    tries_to_override: noulAnswer(0.01),
    requests_dangerous_action: noulAnswer(0.01),
    severity: scoreAnswer(0.0, 0.9),
    satisfies_intent: noulAnswer(0.9),
    result_quality: scoreAnswer(1.0, 0.85),
    evidence_of_success: noulAnswer(0.9),
    operational_failure: noulAnswer(0.05),
  };
}

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function engineWith(provider: SystemOne, policy = POLICY) {
  dir = mkdtempSync(join(tmpdir(), "brainstem-fallback-"));
  const journalPath = join(dir, "session.ndjson");
  const journal = openJournal(journalPath);
  const engine = new ReflexEngine({ systemOne: provider, journal, policy, root: dir });
  return { engine, journalPath };
}

function reflexEvents(journalPath: string) {
  return loadJournal(journalPath).filter((e) => e.t === "reflex");
}

function decisionEvents(journalPath: string) {
  return loadJournal(journalPath).filter((e) => e.t === "decision");
}

describe("engine fallbacks on unavailable judgment", () => {
  test("gate with null floor falls back to ask with 'judgment unavailable'", async () => {
    const { engine, journalPath } = engineWith(mockSystemOne.failing("provider down"));
    const decision = await engine.gate({ tool: "bash", command: "npm test", task: "t" });

    expect(decision.action).toBe("ask");
    expect(decision.reasons).toContain("judgment unavailable");
    expect(decision.result).toBeUndefined();

    const reflexes = reflexEvents(journalPath);
    expect(reflexes).toHaveLength(1);
    const reflex = reflexes[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("unavailable");
    expect(reflex?.t === "reflex" && reflex.reason).toBe("provider down");
    expect(reflex?.t === "reflex" && reflex.result).toBeNull();

    const decisions = decisionEvents(journalPath);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.t === "decision" && decisions[0]?.action).toBe("ask");
    expect(decisions[0]?.t === "decision" && decisions[0]?.judgmentId).toBe(
      reflex?.t === "reflex" ? reflex.judgmentId : undefined,
    );
  });

  test("gate with an ask floor falls back to the static verdict", async () => {
    const { engine } = engineWith(mockSystemOne.failing("provider down"));
    const decision = await engine.gate({ tool: "bash", command: "npm publish", task: "t" });
    expect(decision.action).toBe("ask");
    expect(decision.reasons).toContain("static floor: risky pattern");
  });

  test("cancelled judgment journals cancelled status and gate asks", async () => {
    const { engine, journalPath } = engineWith(mockSystemOne.hanging(), SHORT_DEADLINE_POLICY);
    const decision = await engine.gate({ tool: "bash", command: "npm test", task: "t" });
    expect(decision.action).toBe("ask");
    const reflex = reflexEvents(journalPath)[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("cancelled");
    expect(reflex?.t === "reflex" && reflex.reason).toContain("deadline");
  });

  test("sanitize blocks with withheld content and never returns a result", async () => {
    const { engine, journalPath } = engineWith(mockSystemOne.failing("provider down"));
    const decision = await engine.sanitize("some content", "tool:read README.md");

    expect(decision.action).toBe("block");
    expect(decision.reasons[0]).toBe("sanitizer unavailable — content withheld");
    expect(decision.result).toBeNull();

    const reflex = reflexEvents(journalPath)[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("unavailable");
    const sanitizeDecision = decisionEvents(journalPath).find((e) => e.t === "decision" && e.reflex === "sanitize");
    expect(sanitizeDecision?.t === "decision" && sanitizeDecision?.action).toBe("block");
    const verifyDecision = decisionEvents(journalPath).find((e) => e.t === "decision" && e.reflex === "verify");
    expect(verifyDecision?.t === "decision" && verifyDecision?.action).toBe("ok");
  });

  test("verify marks the result unverified with unavailable status when judgment fails", async () => {
    const { engine, journalPath } = engineWith(mockSystemOne.failing("provider down"));
    const observed = await engine.observeToolResult({ task: "t", source: "tool:read x", actionSummary: "read x", intent: "intent", content: "content" });

    expect(observed.verify.action).toBe("ok");
    expect(observed.verify.verified).toBe(false);
    expect(observed.verify.reasons[0]).toBe("verification unavailable — result not verified");
    expect(observed.result).toBeNull();
    const reflex = reflexEvents(journalPath)[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("unavailable");
  });

  test("a broken verify group does not invalidate a valid sanitize group", async () => {
    const { satisfies_intent: _s, result_quality: _q, ...sanitizeOnly } = sanitizeAnswers();
    const provider = mockSystemOne(() => sanitizeOnly);
    const { engine, journalPath } = engineWith(provider);
    const observed = await engine.observeToolResult({ task: "t", source: "tool:read x", actionSummary: "read x", intent: "intent", content: "clean content" });

    expect(observed.sanitize.action).toBe("pass");
    expect(observed.verify.verified).toBe(false);
    expect(observed.verify.reasons[0]).toBe("verification unavailable — result not verified");
    expect(observed.result).toBeNull();
    const reflex = reflexEvents(journalPath)[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("unavailable");
    const sanitizeDecision = decisionEvents(journalPath).find((e) => e.t === "decision" && e.reflex === "sanitize");
    expect(sanitizeDecision?.t === "decision" && sanitizeDecision?.action).toBe("pass");
  });

  test("a valid verify group under a broken sanitize group still reports unverified", async () => {
    const provider = mockSystemOne(() => ({
      ...sanitizeAnswers(),
      contains_agent_directive: { type: "bogus" } as unknown as Answer,
    }));
    const { engine } = engineWith(provider);
    const observed = await engine.observeToolResult({ task: "t", source: "tool:read x", actionSummary: "read x", intent: "intent", content: "content" });

    expect(observed.sanitize.action).toBe("block");
    expect(observed.sanitize.reasons[0]).toBe("sanitizer unavailable — content withheld");
    expect(observed.verify.verified).toBe(false);
  });

  test("pulse falls back to continue", async () => {
    const { engine, journalPath } = engineWith(mockSystemOne.failing("provider down"));
    const decision = await engine.pulse({ task: "t", events: [], budget: "no budget" });
    expect(decision.action).toBe("continue");
    expect(decision.reasons[0]).toBe("pulse unavailable");
    expect(decision.result).toBeNull();
    const reflex = reflexEvents(journalPath)[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("unavailable");
  });

  test("steer falls back to the frontier model", async () => {
    const { engine, journalPath } = engineWith(mockSystemOne.failing("provider down"));
    const decision = await engine.steer({ task: "t", events: [] });
    expect(decision.tier).toBe("frontier");
    expect(decision.reasons[0]).toBe("steer unavailable — using main model");
    expect(decision.result).toBeNull();
    const reflex = reflexEvents(journalPath)[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("unavailable");
  });

  test("malformed answers count as unavailable, never as data", async () => {
    const provider = mockSystemOne(() => ({ ...gateAnswers(), sneaky: { type: "noul", noul: 0.5 } }));
    const { engine, journalPath } = engineWith(provider);
    const decision = await engine.gate({ tool: "bash", command: "npm test", task: "t" });
    expect(decision.action).toBe("ask");
    expect(decision.reasons).toContain("judgment unavailable");
    const reflex = reflexEvents(journalPath)[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("unavailable");
    expect(reflex?.t === "reflex" && reflex.reason).toContain("unknown answer id");
    expect(reflex?.t === "reflex" && reflex.result).toBeNull();
  });

  test("completed judgments still verify positively", async () => {
    const { engine } = engineWith(mockSystemOne(() => sanitizeAnswers()));
    const observed = await engine.observeToolResult({ task: "t", source: "tool:read x", actionSummary: "read x", intent: "intent", content: "clean" });
    expect(observed.verify.verified).toBe(true);
    expect(observed.result).not.toBeNull();
  });
});

describe("engine deterministic budgets", () => {
  test("checkBudgets breaches independently and unknown spend never breaches spend", () => {
    expect(checkBudgets({ modelCalls: 5, elapsedMs: 0, knownSpendUsd: "unknown" }, { maxModelCalls: 5 })).toEqual({
      ok: false,
      breached: ["maxModelCalls"],
    });
    expect(checkBudgets({ modelCalls: 0, elapsedMs: 5001, knownSpendUsd: "unknown" }, { maxElapsedMs: 5000 })).toEqual({
      ok: false,
      breached: ["maxElapsedMs"],
    });
    expect(
      checkBudgets({ modelCalls: 0, elapsedMs: 0, knownSpendUsd: "unknown" }, { maxSpendUsd: 0.01 }),
    ).toEqual({ ok: true });
    expect(checkBudgets({ modelCalls: 0, elapsedMs: 0, knownSpendUsd: 0.02 }, { maxSpendUsd: 0.01 })).toEqual({
      ok: false,
      breached: ["maxSpendUsd"],
    });
    expect(checkBudgets({ modelCalls: 0, elapsedMs: 0, knownSpendUsd: 5 }, {})).toEqual({ ok: true });
  });

  test("a model-call breach suppresses the Jev call and journals unavailable", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-budget-"));
    const journalPath = join(dir, "session.ndjson");
    const journal = openJournal(journalPath);
    const mock = mockSystemOne(() => gateAnswers());
    const engine = new ReflexEngine({
      systemOne: mock,
      journal,
      policy: POLICY,
      root: dir,
      budgets: { maxModelCalls: 2 },
    });
    engine.noteModelCall();
    engine.noteModelCall();

    const decision = await engine.gate({ tool: "bash", command: "npm test", task: "t" });
    expect(decision.action).toBe("ask");
    expect(decision.reasons).toContain("budget exceeded: maxModelCalls");
    expect(mock.calls).toHaveLength(0);

    const reflex = reflexEvents(journalPath)[0];
    expect(reflex?.t === "reflex" && reflex.status).toBe("unavailable");
    expect(reflex?.t === "reflex" && reflex.reason).toBe("budget exceeded: maxModelCalls");
    expect(reflex?.t === "reflex" && reflex.result).toBeNull();
  });

  test("an elapsed-time breach suppresses Jev calls", async () => {
    let t = 1000;
    dir = mkdtempSync(join(tmpdir(), "brainstem-budget-"));
    const journalPath = join(dir, "session.ndjson");
    const journal = openJournal(journalPath);
    const mock = mockSystemOne(() => sanitizeAnswers());
    const engine = new ReflexEngine({
      systemOne: mock,
      journal,
      policy: POLICY,
      root: dir,
      budgets: { maxElapsedMs: 100 },
      now: () => t,
    });
    t += 101;
    const decision = await engine.pulse({ task: "t", events: [], budget: "b" });
    expect(decision.action).toBe("continue");
    expect(decision.reasons).toContain("budget exceeded: maxElapsedMs");
    expect(mock.calls).toHaveLength(0);
  });

  test("under-budget reflexes still call Jev normally", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-budget-"));
    const journalPath = join(dir, "session.ndjson");
    const journal = openJournal(journalPath);
    const mock = mockSystemOne(() => gateAnswers());
    const engine = new ReflexEngine({
      systemOne: mock,
      journal,
      policy: POLICY,
      root: dir,
      budgets: { maxModelCalls: 10, maxSpendUsd: 1 },
    });
    engine.noteModelCall();
    const decision = await engine.gate({ tool: "bash", command: "npm test", task: "t" });
    expect(decision.action).toBe("auto");
    expect(mock.calls).toHaveLength(1);
  });
});
