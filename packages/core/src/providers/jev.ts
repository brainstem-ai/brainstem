import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { JevCancelledError, JevUnavailableError, isCancelLike } from "../errors";
import type { CircuitBreaker } from "../circuit-breaker";
import type { Answer, AskOptions, AskResult, Question, SystemOne } from "../types";

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

export function jevSystemOne(client: TypeSafeClient, model: string = DEFAULT_JEV_MODEL): SystemOne {
  return {
    name: `jev:${model}`,
    async ask(state, questions: Record<string, Question>, options: AskOptions = {}) {
      if (options.signal?.aborted) throw new JevCancelledError("jev call aborted before start");
      const t0 = performance.now();
      const controller = new AbortController();
      let cancelError: JevCancelledError | undefined;
      let rejectCancellation: ((error: JevCancelledError) => void) | undefined;
      const cancellation = new Promise<never>((_, reject) => {
        rejectCancellation = reject;
      });
      const cancel = (error: JevCancelledError) => {
        cancelError = error;
        controller.abort();
        rejectCancellation!(error);
      };

      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      if (options.deadlineMs !== undefined) {
        deadlineTimer = setTimeout(
          () => cancel(new JevCancelledError(`jev deadline exceeded after ${options.deadlineMs}ms`)),
          options.deadlineMs,
        );
      }

      const onAbort = () => cancel(new JevCancelledError("jev call aborted"));
      if (options.signal) {
        if (options.signal.aborted) cancel(new JevCancelledError("jev call aborted before start"));
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      // The internal controller is passed to the SDK in case it honors signals; if it does
      // not, the cancellation race below still rejects and the SDK call is left to settle.
      //
      // `signal` belongs in the SDK's second (RequestOptions) parameter, not folded into
      // the request body alongside state/questions/model — the `as never` casts previously
      // here hid that mismatch from the type checker, and the server rejected every real
      // call with a 400 as a result. Verified against the SDK's actual published types and
      // a live call after this fix.
      try {
        const response = await Promise.race([
          client.systemOne(
            {
              state: state as never,
              questions: questions as never,
              model,
            },
            { signal: controller.signal },
          ),
          cancellation,
        ]);
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
      } catch (error) {
        if (cancelError) throw cancelError;
        if (isCancelLike(error)) throw new JevCancelledError(error instanceof Error ? error.message : "jev call cancelled");
        throw new JevUnavailableError(error instanceof Error ? error.message : String(error));
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function withCircuitBreaker(provider: SystemOne, breaker: CircuitBreaker): SystemOne {
  return {
    name: `breaker(${provider.name})`,
    async ask(state, questions, options) {
      if (!breaker.canRequest()) throw new JevUnavailableError("circuit open");
      try {
        const result = await provider.ask(state, questions, options);
        breaker.onSuccess();
        return result;
      } catch (error) {
        if (!(error instanceof JevCancelledError)) breaker.onFailure();
        throw error;
      }
    },
  };
}
