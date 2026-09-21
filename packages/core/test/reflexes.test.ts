import { describe, expect, test } from "vitest";
import { decidePulse, decideVerify, decideSteer } from "../src/engine";
import { policyForTrust } from "../src/policy";
import { noulAnswer, scoreAnswer, choiceAnswer } from "../src/providers/mock";
import type { Answer } from "../src/types";

const POLICY = policyForTrust(0.3);

const healthyPulse: Record<string, Answer> = {
  repeating: noulAnswer(0.05),
  approach_changed: noulAnswer(0.05),
  progressing: noulAnswer(0.9),
  stuck_on_same_error: noulAnswer(0.02),
  worth_continuing: scoreAnswer(2.0, 0.9),
};

describe("decidePulse", () => {
  test("continues when progressing and not repeating", () => {
    expect(decidePulse(healthyPulse, POLICY).action).toBe("continue");
  });

  test("intervenes when the agent repeats itself, naming the repeated action", () => {
    const d = decidePulse(
      { ...healthyPulse, repeating: noulAnswer(0.85) },
      POLICY,
      { repeatedAction: { label: "npm test", count: 3 } },
    );
    expect(d.action).toBe("intervene");
    expect(d.reasons[0]).toBe("repeating: npm test x3");
  });

  test("falls back to the numeric reason when no repeated action fact exists", () => {
    const d = decidePulse({ ...healthyPulse, repeating: noulAnswer(0.85) }, POLICY);
    expect(d.action).toBe("intervene");
    expect(d.reasons[0]).toContain("repeating=");
  });

  test("does not intervene for repeating when the approach changed", () => {
    const d = decidePulse(
      { ...healthyPulse, repeating: noulAnswer(0.85), approach_changed: noulAnswer(0.9) },
      POLICY,
      { repeatedAction: { label: "npm test", count: 3 } },
    );
    expect(d.action).toBe("continue");
  });

  test("intervenes when stuck on the same error", () => {
    const d = decidePulse({ ...healthyPulse, stuck_on_same_error: noulAnswer(0.8) }, POLICY);
    expect(d.action).toBe("intervene");
    expect(d.reasons[0]).toContain("stuck");
  });

  test("intervenes when not progressing", () => {
    const d = decidePulse({ ...healthyPulse, progressing: noulAnswer(0.1) }, POLICY);
    expect(d.action).toBe("intervene");
    expect(d.reasons[0]).toContain("progress");
  });

  test("stops when continuing is no longer worth it", () => {
    const d = decidePulse(
      { ...healthyPulse, worth_continuing: scoreAnswer(0.0, 0.9), progressing: noulAnswer(0.2) },
      POLICY,
    );
    expect(d.action).toBe("stop");
  });

  test("missing answers default to continue", () => {
    expect(decidePulse({}, POLICY).action).toBe("continue");
  });
});

describe("decideVerify", () => {
  test("confirms a satisfying result", () => {
    const d = decideVerify(
      {
        satisfies_intent: noulAnswer(0.95),
        evidence_of_success: noulAnswer(0.9),
        result_quality: scoreAnswer(2.0, 0.9),
      },
      POLICY,
    );
    expect(d.action).toBe("ok");
  });

  test("flags a genuine mismatch: low satisfaction AND low success evidence", () => {
    const d = decideVerify(
      {
        satisfies_intent: noulAnswer(0.15),
        evidence_of_success: noulAnswer(0.1),
        result_quality: scoreAnswer(0.0, 0.8),
      },
      POLICY,
    );
    expect(d.action).toBe("mismatch");
    expect(d.reasons.some((r) => r.includes("satisfies_intent"))).toBe(true);
  });

  test("operational failure with satisfying reproduction is ok, with the failure recorded as a reason", () => {
    const d = decideVerify(
      {
        satisfies_intent: noulAnswer(0.9),
        evidence_of_success: noulAnswer(0.85),
        operational_failure: noulAnswer(0.95),
        result_quality: scoreAnswer(2.0, 0.9),
      },
      POLICY,
    );
    expect(d.action).toBe("ok");
    expect(d.reasons.some((r) => r.includes("operational failure"))).toBe(true);
  });

  test("operational failure does not rescue a genuine mismatch", () => {
    const d = decideVerify(
      {
        satisfies_intent: noulAnswer(0.1),
        evidence_of_success: noulAnswer(0.05),
        operational_failure: noulAnswer(0.9),
      },
      POLICY,
    );
    expect(d.action).toBe("mismatch");
    expect(d.reasons.some((r) => r.includes("operational failure"))).toBe(true);
  });

  test("low satisfaction with strong success evidence is not a mismatch", () => {
    const d = decideVerify(
      {
        satisfies_intent: noulAnswer(0.3),
        evidence_of_success: noulAnswer(0.9),
        result_quality: scoreAnswer(1.0, 0.4),
      },
      POLICY,
    );
    expect(d.action).toBe("ok");
  });
});

describe("decideSteer", () => {
  test("routes to mini at high confidence", () => {
    const d = decideSteer(
      { model_tier: choiceAnswer("mini", 0.9, { mini: 0.9, frontier: 0.1 }) },
      POLICY,
    );
    expect(d.tier).toBe("mini");
  });

  test("stays frontier when mini confidence is below the bar", () => {
    const d = decideSteer(
      { model_tier: choiceAnswer("mini", 0.5, { mini: 0.5, frontier: 0.5 }) },
      POLICY,
    );
    expect(d.tier).toBe("frontier");
  });

  test("stays frontier when frontier is chosen", () => {
    const d = decideSteer(
      { model_tier: choiceAnswer("frontier", 0.95, { mini: 0.05, frontier: 0.95 }) },
      POLICY,
    );
    expect(d.tier).toBe("frontier");
  });

  test("defaults to frontier with no answer", () => {
    expect(decideSteer({}, POLICY).tier).toBe("frontier");
  });
});
