import { describe, expect, test } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker";
import { JevCancelledError, JevUnavailableError } from "../src/errors";
import { withCircuitBreaker } from "../src/providers/jev";
import { mockSystemOne } from "../src/providers/mock";

describe("CircuitBreaker", () => {
  test("stays closed below the threshold and opens at threshold consecutive failures", () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 10000, probe: 1 });
    expect(breaker.open).toBe(false);
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.open).toBe(false);
    expect(breaker.canRequest()).toBe(true);
    breaker.onFailure();
    expect(breaker.open).toBe(true);
    expect(breaker.canRequest()).toBe(false);
  });

  test("does not count non-consecutive failures", () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 10000, probe: 1 });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.open).toBe(false);
  });

  test("after cooldown grants exactly probe request(s), then blocks again", () => {
    let t = 1000;
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 5000, probe: 1, now: () => t });
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.canRequest()).toBe(false);
    t += 4999;
    expect(breaker.canRequest()).toBe(false);
    t += 1;
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.canRequest()).toBe(false);
  });

  test("a failed probe restarts the cooldown and stays open", () => {
    let t = 1000;
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 5000, probe: 1, now: () => t });
    breaker.onFailure();
    breaker.onFailure();
    t += 5000;
    expect(breaker.canRequest()).toBe(true);
    breaker.onFailure();
    expect(breaker.canRequest()).toBe(false);
    t += 4999;
    expect(breaker.canRequest()).toBe(false);
    t += 1;
    expect(breaker.canRequest()).toBe(true);
  });

  test("success closes the breaker and resets failure counting", () => {
    let t = 1000;
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 5000, probe: 1, now: () => t });
    breaker.onFailure();
    breaker.onFailure();
    t += 5000;
    expect(breaker.canRequest()).toBe(true);
    breaker.onSuccess();
    expect(breaker.open).toBe(false);
    expect(breaker.canRequest()).toBe(true);
    breaker.onFailure();
    expect(breaker.open).toBe(false);
  });
});

describe("withCircuitBreaker", () => {
  test("fails fast with unavailable 'circuit open' while open", async () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 10000, probe: 1 });
    const provider = withCircuitBreaker(mockSystemOne.failing("provider down"), breaker);
    await expect(provider.ask({}, {})).rejects.toThrow("provider down");
    expect(breaker.open).toBe(true);
    await expect(provider.ask({}, {})).rejects.toBeInstanceOf(JevUnavailableError);
    await expect(provider.ask({}, {})).rejects.toThrow("circuit open");
  });

  test("closes after a successful probe", async () => {
    let t = 0;
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 100, probe: 1, now: () => t });
    let fail = true;
    const flaky = mockSystemOne(() => {
      if (fail) throw new JevUnavailableError("down");
      return {};
    });
    const provider = withCircuitBreaker(flaky, breaker);
    await expect(provider.ask({}, {})).rejects.toThrow("down");
    expect(breaker.open).toBe(true);
    t = 100;
    fail = false;
    await expect(provider.ask({}, {})).resolves.toBeDefined();
    expect(breaker.open).toBe(false);
  });

  test("user cancellation is never counted as a failure", async () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 10000, probe: 1 });
    const cancelProvider = {
      name: "cancel",
      ask: () => Promise.reject(new JevCancelledError("user aborted")),
    };
    const provider = withCircuitBreaker(cancelProvider, breaker);
    await expect(provider.ask({}, {})).rejects.toBeInstanceOf(JevCancelledError);
    expect(breaker.open).toBe(false);
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.canRequest()).toBe(true);
  });
});
