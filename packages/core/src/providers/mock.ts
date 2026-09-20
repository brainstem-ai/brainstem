import type { Answer, AskCall, AskResult, ChoiceAnswer, Question, SystemOne } from "../types";

export function noulAnswer(noul: number): Answer {
  return { type: "noul", noul };
}

export function choiceAnswer(choice: string, confidence: number, probabilities?: Record<string, number>): Answer {
  const answer: ChoiceAnswer = {
    type: "choice",
    choice,
    probabilities: probabilities ?? { [choice]: confidence },
    confidence,
  };
  return answer;
}

export function scoreAnswer(score: number, confidence: number, probabilities?: Record<string, number>): Answer {
  return {
    type: "score",
    score,
    probabilities: probabilities ?? {},
    confidence,
  };
}

export interface MockSystemOne extends SystemOne {
  calls: AskCall[];
}

export function mockSystemOne(
  script: (state: unknown, questions: Record<string, Question>) => Record<string, Answer>,
  name = "mock",
): MockSystemOne {
  const calls: AskCall[] = [];
  return {
    name,
    calls,
    async ask(state, questions) {
      calls.push({ state, questions });
      const answers = script(state, questions);
      const result: AskResult = {
        model: name,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        answers,
      };
      return result;
    },
  };
}
