import { JevCancelledError, JevUnavailableError } from "../errors";
import type { Answer, AskCall, AskOptions, AskResult, ChoiceAnswer, Question, SystemOne } from "../types";

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

export interface MockSystemOneFactory {
  (script: (state: unknown, questions: Record<string, Question>) => Record<string, Answer>, name?: string): MockSystemOne;
  failing(reason: string): MockSystemOne;
  hanging(name?: string): MockSystemOne;
}

export const mockSystemOne = ((script, name = "mock") => {
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
}) as MockSystemOneFactory;

mockSystemOne.failing = (reason: string) => ({
  name: "mock:failing",
  calls: [],
  async ask() {
    throw new JevUnavailableError(reason);
  },
});

// Never settles on its own: resolves only if the caller's deadline/signal fires and rejects.
mockSystemOne.hanging = (name = "mock:hanging"): MockSystemOne => {
  const calls: AskCall[] = [];
  return {
    name,
    calls,
    ask(_state, _questions, options: AskOptions = {}) {
      return new Promise<AskResult>((_resolve, reject) => {
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        if (options.deadlineMs !== undefined) {
          deadlineTimer = setTimeout(
            () => reject(new JevCancelledError(`deadline exceeded after ${options.deadlineMs}ms`)),
            options.deadlineMs,
          );
        }
        const onAbort = () => {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          reject(new JevCancelledError("aborted"));
        };
        if (options.signal) {
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  };
};
