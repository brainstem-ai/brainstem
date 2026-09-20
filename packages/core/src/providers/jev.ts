import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Answer, AskResult, Question, SystemOne } from "../types";

export const DEFAULT_JEV_MODEL = "jev-1.13.0";

function mapAnswers(raw: Record<string, unknown>): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(raw)) {
    const a = value as Record<string, unknown>;
    if (a.type === "noul") {
      answers[id] = { type: "noul", noul: a.noul as number };
    } else if (a.type === "choice") {
      answers[id] = {
        type: "choice",
        choice: a.choice as string,
        probabilities: (a.probabilities ?? {}) as Record<string, number>,
        confidence: a.confidence as number,
      };
    } else if (a.type === "score") {
      answers[id] = {
        type: "score",
        score: a.score as number,
        probabilities: (a.probabilities ?? {}) as Record<string, number>,
        confidence: a.confidence as number,
      };
    }
  }
  return answers;
}

export function jevSystemOne(client: TypeSafeClient, model = DEFAULT_JEV_MODEL): SystemOne {
  return {
    name: `jev:${model}`,
    async ask(state, questions: Record<string, Question>) {
      const t0 = performance.now();
      const response = await client.systemOne({
        state: state as never,
        questions: questions as never,
        model,
      });
      const result: AskResult = {
        model: response.model,
        latencyMs: performance.now() - t0,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        answers: mapAnswers(response.answers as unknown as Record<string, unknown>),
      };
      return result;
    },
  };
}
