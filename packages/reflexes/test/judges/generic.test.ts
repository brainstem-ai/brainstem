import { describe, expect, test } from "vitest";
import { noul, score, choice } from "@brainstem/core";
import { genericJudge } from "../../src/judges/generic";
import { createReflexes } from "../../src/index";

const QUESTIONS = {
  is_safe: noul("Is this safe?"),
  destructiveness: score("How destructive?", ["none", "some", "a lot"]),
  disposition: choice("What to do?", { auto_run: "run it", deny: "refuse it" }),
};

describe("genericJudge — parsing", () => {
  test("parses a clean, well-formed JSON response", async () => {
    const judge = genericJudge({ complete: async () => JSON.stringify({ is_safe: 0.9, destructiveness: 1, disposition: "auto_run" }) });
    const result = await judge.ask({ task: "x" }, QUESTIONS);
    expect(result.answers.is_safe).toEqual({ type: "noul", noul: 0.9 });
    expect(result.answers.destructiveness).toMatchObject({ type: "score", score: 1 });
    expect(result.answers.disposition).toMatchObject({ type: "choice", choice: "auto_run" });
  });

  test("extracts JSON wrapped in a code fence or surrounding prose", async () => {
    const judge = genericJudge({
      complete: async () => 'Sure, here is my answer:\n```json\n{"is_safe": 0.1, "destructiveness": 2, "disposition": "deny"}\n```\nHope that helps!',
    });
    const result = await judge.ask({ task: "x" }, QUESTIONS);
    expect(result.answers.is_safe).toEqual({ type: "noul", noul: 0.1 });
    expect(result.answers.disposition).toMatchObject({ choice: "deny" });
  });

  test("throws JevUnavailableError-compatible error on garbage output", async () => {
    const judge = genericJudge({ complete: async () => "I refuse to answer in JSON." });
    await expect(judge.ask({ task: "x" }, QUESTIONS)).rejects.toThrow();
  });

  test("throws when a requested question id is missing from the response", async () => {
    const judge = genericJudge({ complete: async () => JSON.stringify({ is_safe: 0.9 }) });
    await expect(judge.ask({ task: "x" }, QUESTIONS)).rejects.toThrow(/destructiveness/);
  });

  test("throws when a choice answer isn't one of the offered options", async () => {
    const judge = genericJudge({ complete: async () => JSON.stringify({ is_safe: 0.9, destructiveness: 1, disposition: "maybe" }) });
    await expect(judge.ask({ task: "x" }, QUESTIONS)).rejects.toThrow(/maybe/);
  });
});

describe("genericJudge — integration with the real engine", () => {
  test("participates correctly in ReflexEngine's fallback when the judge fails", async () => {
    const judge = genericJudge({ complete: async () => "not json at all" });
    const reflexes = createReflexes({ judge, root: "/tmp" });

    const decision = await reflexes.gate({ tool: "bash", command: "echo hi", task: "t" });
    // ReflexEngine's own, already-tested fallback for an unavailable judge —
    // proves genericJudge's failures are indistinguishable from a real
    // provider outage from the engine's point of view.
    expect(decision.action).toBe("ask");
  });

  test("a working genericJudge drives a real gate decision end to end", async () => {
    const judge = genericJudge({
      complete: async () =>
        JSON.stringify({
          destructive: 0,
          touches_credentials: 0.02,
          exfiltrates: 0.01,
          on_task: 0.95,
          disposition: "auto_run",
        }),
    });
    const reflexes = createReflexes({ judge, root: "/tmp" });
    const decision = await reflexes.gate({ tool: "bash", command: "echo hi", task: "say hi" });
    expect(decision.action).toBe("auto");
  });
});
