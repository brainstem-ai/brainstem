import { describe, expect, test } from "vitest";
import { choiceAnswer, mockSystemOne, noulAnswer, scoreAnswer } from "../src/providers/mock";
import { jevSystemOne, withCircuitBreaker } from "../src/providers/jev";
import { JevCancelledError, JevUnavailableError } from "../src/errors";
import { CircuitBreaker } from "../src/circuit-breaker";
import type { Question } from "../src/types";

const questions: Record<string, Question> = {
  safe: { type: "noul", instructions: "Is the command safe?" },
  disposition: {
    type: "choice",
    instructions: "What should the harness do?",
    criteria: { auto_run: "Run it.", ask_user: "Confirm first.", deny: "Refuse." },
  },
  severity: {
    type: "score",
    instructions: "How severe?",
    criteria: ["none", "mild", "serious", "severe"],
  },
};

describe("mock provider", () => {
  test("returns scripted answers and records calls with state", async () => {
    const mock = mockSystemOne(() => ({
      safe: noulAnswer(0.05),
      disposition: choiceAnswer("auto_run", 0.95),
      severity: scoreAnswer(0.2, 0.9),
    }));

    const result = await mock.ask({ task: "fix test" }, questions);

    expect(result.answers.safe).toEqual({ type: "noul", noul: 0.05 });
    expect(result.answers.disposition).toEqual({
      type: "choice",
      choice: "auto_run",
      probabilities: { auto_run: 0.95 },
      confidence: 0.95,
    });
    expect(result.answers.severity?.type === "score" && result.answers.severity.score).toBe(0.2);
    expect(result.model).toBe("mock");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.state).toEqual({ task: "fix test" });
    expect(Object.keys(mock.calls[0]?.questions ?? {})).toEqual(["safe", "disposition", "severity"]);
  });
});

describe("jev provider", () => {
  test("maps SDK wire responses to port answers", async () => {
    const fakeClient = {
      systemOne: async () => ({
        model: "jev-1.13.0",
        usage: { input_tokens: 1200, output_tokens: 3 },
        answers: {
          safe: { type: "noul", noul: 0.91 },
          disposition: {
            type: "choice",
            choice: "deny",
            probabilities: { deny: 0.99, auto_run: 0.01, ask_user: 0 },
            confidence: 0.99,
          },
          severity: {
            type: "score",
            score: 2.4,
            legend: { 0: "none", 1: "mild", 2: "serious", 3: "severe" },
            probabilities: { 0: 0, 1: 0, 2: 0.6, 3: 0.4 },
            confidence: 0.9,
          },
        },
      }),
    };

    const provider = jevSystemOne(fakeClient as never, "jev-1.13.0");
    const result = await provider.ask("state text", questions);

    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 3 });
    expect(result.answers.safe).toEqual({ type: "noul", noul: 0.91 });
    expect(result.answers.disposition).toEqual({
      type: "choice",
      choice: "deny",
      probabilities: { deny: 0.99, auto_run: 0.01, ask_user: 0 },
      confidence: 0.99,
    });
    const severity = result.answers.severity;
    expect(severity?.type === "score" && severity.score).toBe(2.4);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("forwards state, questions, and pinned model to the SDK client", async () => {
    const seen: unknown[] = [];
    const fakeClient = {
      systemOne: async (req: unknown) => {
        seen.push(req);
        return {
          model: "jev-1.13.0",
          usage: { input_tokens: 1, output_tokens: 0 },
          answers: { safe: { type: "noul", noul: 0.5 } },
        };
      },
    };

    const provider = jevSystemOne(fakeClient as never, "jev-1.13.0");
    await provider.ask({ task: "x" }, { safe: questions.safe! });

    expect(seen[0]).toEqual({
      state: { task: "x" },
      questions: { safe: questions.safe },
      model: "jev-1.13.0",
      signal: expect.any(AbortSignal),
    });
  });

  test("hanging SDK call past the deadline rejects cancelled", async () => {
    const hangingClient = {
      systemOne: () => new Promise<never>(() => {}),
    };
    const provider = jevSystemOne(hangingClient as never);
    await expect(provider.ask({}, questions, { deadlineMs: 20 })).rejects.toBeInstanceOf(JevCancelledError);
  });

  test("signal aborted mid-call maps to cancelled", async () => {
    const hangingClient = {
      systemOne: () => new Promise<never>(() => {}),
    };
    const provider = jevSystemOne(hangingClient as never);
    const controller = new AbortController();
    const pending = provider.ask({}, questions, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toBeInstanceOf(JevCancelledError);
  });

  test("an already-aborted signal rejects before any call", async () => {
    const seen: unknown[] = [];
    const client = {
      systemOne: async (req: unknown) => {
        seen.push(req);
        return { model: "m", usage: { input_tokens: 0, output_tokens: 0 }, answers: {} };
      },
    };
    const provider = jevSystemOne(client as never);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.ask({}, questions, { signal: controller.signal })).rejects.toBeInstanceOf(JevCancelledError);
    expect(seen).toHaveLength(0);
  });

  test("SDK failure maps to unavailable, not cancelled", async () => {
    const client = {
      systemOne: async () => {
        throw new Error("boom");
      },
    };
    const provider = jevSystemOne(client as never);
    await expect(provider.ask({}, questions)).rejects.toBeInstanceOf(JevUnavailableError);
    await expect(provider.ask({}, questions)).rejects.toThrow("boom");
  });
});

describe("mock helpers", () => {
  test("failing rejects unavailable with the scripted reason", async () => {
    await expect(mockSystemOne.failing("provider down").ask({}, {})).rejects.toThrow("provider down");
  });

  test("hanging never settles without a deadline but rejects cancelled when it fires", async () => {
    const hanging = mockSystemOne.hanging();
    let settled = false;
    hanging.ask({}, {}).then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 15));
    expect(settled).toBe(false);

    const withDeadline = mockSystemOne.hanging();
    await expect(withDeadline.ask({}, {}, { deadlineMs: 10 })).rejects.toBeInstanceOf(JevCancelledError);
  });

  test("hanging honors an abort signal", async () => {
    const controller = new AbortController();
    const pending = mockSystemOne.hanging().ask({}, {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toBeInstanceOf(JevCancelledError);
  });

  test("withCircuitBreaker decorates through to the provider", async () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 10000, probe: 1 });
    const mock = mockSystemOne(() => ({ safe: noulAnswer(0.5) }));
    const provider = withCircuitBreaker(mock, breaker);
    const result = await provider.ask({ task: "x" }, { safe: questions.safe! });
    expect(result.answers.safe).toEqual({ type: "noul", noul: 0.5 });
    expect(mock.calls).toHaveLength(1);
    expect(breaker.open).toBe(false);
  });
});
