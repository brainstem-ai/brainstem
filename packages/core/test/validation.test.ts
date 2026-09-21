import { describe, expect, test } from "vitest";
import { validateAnswers, validateGroups } from "../src/validation";
import { JevUnavailableError } from "../src/errors";
import type { Question } from "../src/types";

const questions: Record<string, Question> = {
  safe: { type: "noul", instructions: "safe?" },
  severity: { type: "score", instructions: "severity?", criteria: ["none", "mild", "serious"] },
  disposition: {
    type: "choice",
    instructions: "what to do?",
    criteria: { auto_run: "run", ask_user: "ask", deny: "refuse" },
  },
};

const validRaw = {
  safe: { type: "noul", noul: 0.1 },
  severity: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8 }, confidence: 0.9 },
  disposition: {
    type: "choice",
    choice: "auto_run",
    probabilities: { auto_run: 0.9, ask_user: 0.1, deny: 0 },
    confidence: 0.9,
  },
};

function expectUnavailable(run: () => unknown): string {
  try {
    run();
    throw new Error("expected JevUnavailableError");
  } catch (error) {
    expect(error).toBeInstanceOf(JevUnavailableError);
    return (error as JevUnavailableError).message;
  }
}

describe("validateAnswers", () => {
  test("accepts well-formed answers", () => {
    const answers = validateAnswers(questions, validRaw);
    expect(Object.keys(answers).sort()).toEqual(["disposition", "safe", "severity"]);
    expect(answers.safe).toEqual({ type: "noul", noul: 0.1 });
  });

  test("rejects a missing question id", () => {
    const { safe: _safe, ...incomplete } = validRaw;
    expectUnavailable(() => validateAnswers(questions, incomplete));
  });

  test("rejects unknown answer ids", () => {
    expectUnavailable(() => validateAnswers(questions, { ...validRaw, sneaky: { type: "noul", noul: 0.5 } }));
  });

  test("rejects a type mismatch", () => {
    expectUnavailable(() =>
      validateAnswers(questions, { ...validRaw, safe: { type: "score", score: 0, confidence: 0.9 } }),
    );
  });

  test("rejects noul outside [0,1] and non-finite noul", () => {
    expectUnavailable(() => validateAnswers(questions, { ...validRaw, safe: { type: "noul", noul: 1.5 } }));
    expectUnavailable(() => validateAnswers(questions, { ...validRaw, safe: { type: "noul", noul: -0.1 } }));
    expectUnavailable(() => validateAnswers(questions, { ...validRaw, safe: { type: "noul", noul: Number.NaN } }));
  });

  test("rejects score out of the criteria range", () => {
    expectUnavailable(() =>
      validateAnswers(questions, { ...validRaw, severity: { type: "score", score: 3, confidence: 0.9 } }),
    );
    expectUnavailable(() =>
      validateAnswers(questions, { ...validRaw, severity: { type: "score", score: -1, confidence: 0.9 } }),
    );
  });

  test("rejects a choice outside the criteria keys", () => {
    expectUnavailable(() =>
      validateAnswers(questions, {
        ...validRaw,
        disposition: { type: "choice", choice: "escalate", confidence: 0.9 },
      }),
    );
  });

  test("rejects missing confidence on choice and score answers (never defaulted)", () => {
    const { confidence: _c, ...noConfidence } = validRaw.disposition as Record<string, unknown>;
    expectUnavailable(() => validateAnswers(questions, { ...validRaw, disposition: noConfidence }));
    const { confidence: _s, ...noScoreConfidence } = validRaw.severity as Record<string, unknown>;
    expectUnavailable(() => validateAnswers(questions, { ...validRaw, severity: noScoreConfidence }));
  });

  test("rejects confidence outside [0,1]", () => {
    expectUnavailable(() =>
      validateAnswers(questions, {
        ...validRaw,
        disposition: { ...validRaw.disposition, confidence: 1.2 },
      }),
    );
  });

  test("tolerates missing probabilities but rejects malformed ones", () => {
    const noProbs = { ...validRaw.disposition };
    delete (noProbs as Record<string, unknown>).probabilities;
    const answers = validateAnswers(questions, { ...validRaw, disposition: noProbs });
    expect(answers.disposition?.type === "choice" && answers.disposition.probabilities).toEqual({});

    expectUnavailable(() =>
      validateAnswers(questions, {
        ...validRaw,
        disposition: { ...validRaw.disposition, probabilities: "high" },
      }),
    );
    expectUnavailable(() =>
      validateAnswers(questions, {
        ...validRaw,
        disposition: { ...validRaw.disposition, probabilities: { auto_run: 2 } },
      }),
    );
    expectUnavailable(() =>
      validateAnswers(questions, {
        ...validRaw,
        disposition: { ...validRaw.disposition, probabilities: { auto_run: Number.POSITIVE_INFINITY } },
      }),
    );
  });
});

describe("validateGroups", () => {
  const fusedQuestions = {
    ...Object.fromEntries([["contains_agent_directive", questions.safe]]),
    satisfies_intent: questions.safe,
  } as Record<string, Question>;
  const groups = { sanitize: ["contains_agent_directive"], verify: ["satisfies_intent"] };

  test("a broken group does not invalidate a valid sibling group", () => {
    const raw = {
      contains_agent_directive: { type: "noul", noul: 0.1 },
      satisfies_intent: { type: "noul", noul: 9 },
    };
    const result = validateGroups(fusedQuestions, raw, groups);
    expect(result.errors.verify).toBeDefined();
    expect(result.groups.verify).toBeNull();
    expect(result.groups.sanitize).toEqual({ contains_agent_directive: { type: "noul", noul: 0.1 } });
  });

  test("reports no errors and both groups when everything is valid", () => {
    const raw = {
      contains_agent_directive: { type: "noul", noul: 0.1 },
      satisfies_intent: { type: "noul", noul: 0.9 },
    };
    const result = validateGroups(fusedQuestions, raw, groups);
    expect(result.errors).toEqual({});
    expect(result.groups.sanitize).not.toBeNull();
    expect(result.groups.verify).not.toBeNull();
  });

  test("marks a group null when an id is missing entirely", () => {
    const result = validateGroups(fusedQuestions, { contains_agent_directive: { type: "noul", noul: 0.1 } }, groups);
    expect(result.groups.verify).toBeNull();
    expect(result.errors.verify).toContain("satisfies_intent");
  });
});
