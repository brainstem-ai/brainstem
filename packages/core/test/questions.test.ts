import { describe, expect, test } from "vitest";
import { gateQuestions, pulseQuestions, sanitizeQuestions, sanitizeVerifyGroups, verifyQuestions } from "../src/questions";

describe("gateQuestions", () => {
  test("builds the battery without writes_outside_project (containment resolved in code)", () => {
    const q = gateQuestions("fix the failing auth test");
    const ids = Object.keys(q).sort();
    expect(ids).toEqual(
      ["destructive", "disposition", "exfiltrates", "on_task", "touches_credentials"].sort(),
    );
  });

  test("every question is typed and names its target with backticks", () => {
    const q = gateQuestions("fix the failing auth test");
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

describe("verifyQuestions", () => {
  test("adds evidence_of_success and operational_failure as new disjoint ids", () => {
    const q = verifyQuestions();
    expect(Object.keys(q).sort()).toEqual(
      [
        "evidence_of_success",
        "operational_failure",
        "result_quality",
        "satisfies_intent",
      ].sort(),
    );
    expect(q.evidence_of_success?.type).toBe("noul");
    expect(q.operational_failure?.type).toBe("noul");
    expect(q.operational_failure?.instructions).toContain("TOOL ITSELF");
  });

  test("the fused battery keeps group validation with the new ids in the verify group", () => {
    const groups = sanitizeVerifyGroups();
    const verifyIds = groups.verify ?? [];
    expect(verifyIds).toContain("evidence_of_success");
    expect(verifyIds).toContain("operational_failure");
    const sanitizeIds = new Set(groups.sanitize ?? []);
    for (const id of verifyIds) expect(sanitizeIds.has(id)).toBe(false);
  });
});

describe("pulseQuestions", () => {
  test("repeating targets the same command or edit on the same target", () => {
    const q = pulseQuestions();
    expect(q.repeating?.instructions).toContain("SAME command or edit on the SAME target");
    expect(q.repeating?.instructions).toContain("without material changes");
  });

  test("includes approach_changed", () => {
    const q = pulseQuestions();
    expect(q.approach_changed?.type).toBe("noul");
    expect(q.approach_changed?.instructions).toContain("meaningfully changed its approach");
  });
});
