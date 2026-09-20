import { describe, expect, test } from "vitest";
import { DEFAULT_TRUST, policyForTrust } from "../src/policy";

describe("policyForTrust", () => {
  test("default policy matches Phase 0 validated thresholds", () => {
    const p = policyForTrust(0.3);
    expect(p.model).toBe("jev-1.13.0");
    expect(p.confidenceFloor).toBe(0.5);
    expect(p.gate.denyDestructive).toBe(1.5);
    expect(p.gate.askDestructive).toBe(0.5);
    expect(p.gate.credentialNoul).toBe(0.5);
    expect(p.gate.exfilNoul).toBe(0.5);
    expect(p.gate.offTaskOnTask).toBe(0.3);
    expect(p.sanitize.review).toBe(0.35);
    expect(p.sanitize.action).toBe(0.7);
    expect(p.sanitize.severityBlock).toBe(2.0);
  });

  test("higher trust lowers the auto-run confidence bar monotonically", () => {
    const t0 = policyForTrust(0);
    const t3 = policyForTrust(0.3);
    const t5 = policyForTrust(0.5);
    const t1 = policyForTrust(1);

    expect(t0.gate.autoConfidence).toBeGreaterThan(t3.gate.autoConfidence);
    expect(t3.gate.autoConfidence).toBeGreaterThan(t5.gate.autoConfidence);
    expect(t5.gate.autoConfidence).toBeGreaterThan(t1.gate.autoConfidence);
    expect(t1.gate.autoConfidence).toBe(0.6);
  });

  test("trust never relaxes safety thresholds", () => {
    const low = policyForTrust(0);
    const high = policyForTrust(1);
    expect(high.gate.denyDestructive).toBe(low.gate.denyDestructive);
    expect(high.gate.credentialNoul).toBe(low.gate.credentialNoul);
    expect(high.gate.exfilNoul).toBe(low.gate.exfilNoul);
    expect(high.gate.askDestructive).toBe(low.gate.askDestructive);
    expect(high.confidenceFloor).toBe(low.confidenceFloor);
  });

  test("clamps out-of-range trust", () => {
    expect(policyForTrust(-3).gate.autoConfidence).toBe(policyForTrust(0).gate.autoConfidence);
    expect(policyForTrust(42).gate.autoConfidence).toBe(policyForTrust(1).gate.autoConfidence);
  });

  test("DEFAULT_TRUST is 0.3", () => {
    expect(DEFAULT_TRUST).toBe(0.3);
  });
});
