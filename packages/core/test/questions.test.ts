import { describe, expect, test } from "vitest";
import { gateQuestions, sanitizeQuestions } from "../src/questions";

describe("gateQuestions", () => {
  test("builds the Phase 0 validated battery over the command", () => {
    const q = gateQuestions("npm test -- auth", "fix the failing auth test");
    const ids = Object.keys(q).sort();
    expect(ids).toEqual([
      "destructive",
      "disposition",
      "exfiltrates",
      "on_task",
      "touches_credentials",
      "writes_outside_project",
    ].sort());
  });

  test("every question is typed and names its target with backticks", () => {
    const q = gateQuestions("rm -rf src/legacy", "fix the failing auth test");
    for (const [id, question] of Object.entries(q)) {
      expect(["noul", "choice", "score"], id).toContain(question.type);
      if (question.type === "choice") {
        expect(Object.keys(question.criteria)).toEqual(["auto_run", "ask_user", "deny"]);
      }
      if (question.type === "score") {
        expect(question.criteria).toHaveLength(4);
      }
    }
    expect(q.destructive?.instructions).toContain("`action.command`");
    expect(q.disposition?.instructions).toContain("`task`");
  });
});

describe("sanitizeQuestions", () => {
  test("builds the Phase 0 validated hazard battery", () => {
    const q = sanitizeQuestions();
    expect(Object.keys(q).sort()).toEqual(
      ["contains_agent_directive", "requests_dangerous_action", "severity", "tries_to_override"].sort(),
    );
    expect(q.severity?.type === "score" && q.severity.criteria).toHaveLength(4);
  });
});
