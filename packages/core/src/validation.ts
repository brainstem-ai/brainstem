import { JevUnavailableError } from "./errors";
import type { Answer, ChoiceAnswer, Question, ScoreAnswer } from "./types";

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function fail(reason: string): never {
  throw new JevUnavailableError(reason);
}

function inUnitRange(n: number): boolean {
  return n >= 0 && n <= 1;
}

function validateProbabilities(id: string, probabilities: unknown): void {
  if (probabilities === undefined) return;
  if (probabilities === null || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    fail(`answer "${id}": probabilities must be an object`);
  }
  for (const [key, value] of Object.entries(probabilities as Record<string, unknown>)) {
    if (!finite(value) || !inUnitRange(value)) {
      fail(`answer "${id}": probability "${key}" must be a finite number in [0,1]`);
    }
  }
}

function validateAnswer(id: string, question: Question, answer: unknown): Answer {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    fail(`answer "${id}" is missing or not an object`);
  }
  const a = answer as Record<string, unknown>;

  if (question.type === "noul") {
    if (a.type !== "noul") fail(`answer "${id}": expected type "noul", got "${String(a.type)}"`);
    if (!finite(a.noul) || !inUnitRange(a.noul)) fail(`answer "${id}": noul must be a finite number in [0,1]`);
    return { type: "noul", noul: a.noul };
  }

  if (question.type === "score") {
    if (a.type !== "score") fail(`answer "${id}": expected type "score", got "${String(a.type)}"`);
    const max = question.criteria.length - 1;
    if (!finite(a.score) || a.score < 0 || a.score > max) {
      fail(`answer "${id}": score must be a finite number in [0,${max}]`);
    }
    validateProbabilities(id, a.probabilities);
    if (!finite(a.confidence) || !inUnitRange(a.confidence)) {
      fail(`answer "${id}": confidence must be a finite number in [0,1]`);
    }
    const scored: ScoreAnswer = {
      type: "score",
      score: a.score,
      probabilities: (a.probabilities ?? {}) as Record<string, number>,
      confidence: a.confidence,
    };
    return scored;
  }

  if (a.type !== "choice") fail(`answer "${id}": expected type "choice", got "${String(a.type)}"`);
  if (typeof a.choice !== "string" || !(a.choice in question.criteria)) {
    fail(`answer "${id}": choice must be one of ${Object.keys(question.criteria).join(", ")}`);
  }
  validateProbabilities(id, a.probabilities);
  if (!finite(a.confidence) || !inUnitRange(a.confidence)) {
    fail(`answer "${id}": confidence must be a finite number in [0,1]`);
  }
  const chosen: ChoiceAnswer = {
    type: "choice",
    choice: a.choice,
    probabilities: (a.probabilities ?? {}) as Record<string, number>,
    confidence: a.confidence,
  };
  return chosen;
}

export function validateAnswers(
  questions: Record<string, Question>,
  rawAnswers: Record<string, unknown>,
): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const id of Object.keys(questions)) {
    answers[id] = validateAnswer(id, questions[id]!, rawAnswers[id]);
  }
  for (const id of Object.keys(rawAnswers)) {
    if (!(id in questions)) fail(`unknown answer id "${id}"`);
  }
  return answers;
}

export function validateGroups(
  questions: Record<string, Question>,
  rawAnswers: Record<string, unknown>,
  groups: Record<string, string[]>,
): { groups: Record<string, Record<string, Answer> | null>; errors: Record<string, string> } {
  const valid: Record<string, Record<string, Answer> | null> = {};
  const errors: Record<string, string> = {};
  for (const [name, ids] of Object.entries(groups)) {
    const subQuestions: Record<string, Question> = {};
    const subRaw: Record<string, unknown> = {};
    for (const id of ids) {
      const question = questions[id];
      if (question) subQuestions[id] = question;
      if (id in rawAnswers) subRaw[id] = rawAnswers[id];
    }
    try {
      valid[name] = validateAnswers(subQuestions, subRaw);
    } catch (error) {
      valid[name] = null;
      errors[name] = error instanceof Error ? error.message : String(error);
    }
  }
  return { groups: valid, errors };
}
