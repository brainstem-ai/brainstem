import { JevUnavailableError, type Answer, type Question, type SystemOne } from "@brainstem/core";

export interface GenericJudgeOptions {
  /** The consumer's own LLM call — however they already talk to whatever model they use. */
  complete: (prompt: string) => Promise<string>;
  /** Label only, reported in AskResult.model — this judge has no fixed model of its own. */
  model?: string;
}

function describeQuestion(id: string, q: Question): string {
  if (q.type === "noul") {
    return `- "${id}" (noul): ${q.instructions}\n  Answer with a number from 0 to 1 (probability of "true").`;
  }
  if (q.type === "score") {
    const levels = q.criteria.map((c, i) => `${i}=${c}`).join("; ");
    return `- "${id}" (score, 0 to ${q.criteria.length - 1}): ${q.instructions}\n  Levels: ${levels}`;
  }
  const choices = Object.entries(q.criteria)
    .map(([k, v]) => `"${k}"=${v}`)
    .join("; ");
  return `- "${id}" (choice): ${q.instructions}\n  Options: ${choices}`;
}

function buildPrompt(state: unknown, questions: Record<string, Question>): string {
  const lines = Object.entries(questions).map(([id, q]) => describeQuestion(id, q));
  return [
    "You are answering structured questions about the state below. Respond with ONLY a single JSON object, no prose, no code fences — one key per question id.",
    "",
    `State: ${JSON.stringify(state)}`,
    "",
    "Questions:",
    ...lines,
    "",
    'Respond as JSON, e.g. {"some_id": 0.2, "other_id": 3, "third_id": "auto_run"}',
  ].join("\n");
}

// Models often ignore "no prose" instructions and wrap JSON in a sentence or
// a code fence despite being told not to — extract the first {...} block
// rather than assume a clean parse.
function extractJson(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object found in response");
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function toAnswer(id: string, q: Question, raw: unknown): Answer {
  if (q.type === "noul") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`question "${id}": expected a number, got ${JSON.stringify(raw)}`);
    return { type: "noul", noul: n };
  }
  if (q.type === "score") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`question "${id}": expected a number, got ${JSON.stringify(raw)}`);
    // Synthetic confidence: a plain-text completion has no native calibrated
    // confidence signal, unlike Jev's. Callers relying on genericJudge should
    // treat `confidence` as a placeholder, not a real measurement.
    return { type: "score", score: n, probabilities: {}, confidence: 1 };
  }
  const choice = String(raw);
  if (!(choice in q.criteria)) throw new Error(`question "${id}": "${choice}" is not one of ${Object.keys(q.criteria).join(", ")}`);
  return { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
}

/**
 * A generic SystemOne backed by any chat-completions-style API the caller
 * already has access to. Exists to make "the judge is pluggable" a
 * demonstrated fact, not just an interface nobody but Jev implements.
 */
export function genericJudge(options: GenericJudgeOptions): SystemOne {
  return {
    name: options.model ?? "generic",
    async ask(state, questions) {
      const t0 = performance.now();
      let text: string;
      try {
        text = await options.complete(buildPrompt(state, questions));
      } catch (error) {
        throw new JevUnavailableError(error instanceof Error ? error.message : String(error));
      }

      let raw: Record<string, unknown>;
      try {
        raw = extractJson(text);
      } catch (error) {
        throw new JevUnavailableError(
          `genericJudge: could not parse a JSON response (${error instanceof Error ? error.message : String(error)})`,
        );
      }

      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (!(id in raw)) {
          throw new JevUnavailableError(`genericJudge: response is missing answer for question "${id}"`);
        }
        try {
          answers[id] = toAnswer(id, q, raw[id]);
        } catch (error) {
          throw new JevUnavailableError(`genericJudge: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return {
        model: options.model ?? "generic",
        latencyMs: performance.now() - t0,
        // Token counts are unavailable at this abstraction level — `complete`
        // is a bare string-in, string-out function with no usage metadata.
        // 0 signals "not measured," never a real free call.
        usage: { inputTokens: 0, outputTokens: 0 },
        answers,
      };
    },
  };
}
