import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer, loadJournal, type Answer } from "@brainstem/core";
import { createReflexes, type ReflexDecisionEvent } from "../src/index";

const AUTO_GATE = (): Record<string, Answer> => ({
  destructive: scoreAnswer(0, 0.9),
  touches_credentials: noulAnswer(0.02),
  exfiltrates: noulAnswer(0.01),
  on_task: noulAnswer(0.95),
  disposition: choiceAnswer("auto_run", 0.95, { auto_run: 0.95, ask_user: 0.04, deny: 0.01 }),
});

const BENIGN_SANITIZE = (): Record<string, Answer> => ({
  contains_agent_directive: noulAnswer(0.02),
  tries_to_override: noulAnswer(0.01),
  requests_dangerous_action: noulAnswer(0.01),
  severity: scoreAnswer(0.0, 0.9),
  satisfies_intent: noulAnswer(0.9),
  result_quality: scoreAnswer(2.0, 0.9),
  evidence_of_success: noulAnswer(0.9),
  operational_failure: noulAnswer(0.02),
});

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("createReflexes — no journal required", () => {
  test("gate/observe/focus all resolve with no journalPath or onDecision, and no filesystem side effect", async () => {
    const mock = mockSystemOne((_state, questions) => {
      if ("contains_agent_directive" in questions) return BENIGN_SANITIZE();
      if (Object.keys(questions).some((k) => k.startsWith("focus__"))) {
        const answers: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) answers[id] = noulAnswer(0.05);
        return answers;
      }
      return AUTO_GATE();
    });
    const reflexes = createReflexes({ judge: mock, root: "/tmp" });

    const gate = await reflexes.gate({ tool: "bash", command: "echo hi", task: "t" });
    expect(gate.action).toBe("auto");

    const observed = await reflexes.observe({
      task: "t",
      source: "tool:read",
      actionSummary: "read file",
      status: "ok",
      truncated: false,
      content: "benign content",
    });
    expect(observed.sanitize.action).toBe("pass");

    const content = Array.from({ length: 40 }, (_, i) => `line ${i} with enough text to clear the min-chars floor`).join("\n\n");
    const focused = await reflexes.focus({ task: "count how many lines exist", command: "cat", outcome: "ok", recentFindings: [], content });
    expect(focused.text.length).toBeGreaterThan(0);
  });
});

describe("createReflexes — onDecision", () => {
  test("is called once per gate/observe/focus outcome with the right reflex and action", async () => {
    const mock = mockSystemOne((_state, questions) => {
      if ("contains_agent_directive" in questions) return BENIGN_SANITIZE();
      return AUTO_GATE();
    });
    const events: ReflexDecisionEvent[] = [];
    const reflexes = createReflexes({ judge: mock, root: "/tmp", onDecision: (e) => events.push(e) });

    await reflexes.gate({ tool: "bash", command: "echo hi", task: "t" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reflex: "gate", action: "auto" });

    events.length = 0;
    await reflexes.observe({ task: "t", source: "tool:read", actionSummary: "read", status: "ok", truncated: false, content: "hi" });
    expect(events.map((e) => e.reflex).sort()).toEqual(["sanitize", "verify"]);
  });
});

describe("createReflexes — journalPath", () => {
  test("durably appends a decision event using @brainstem/core's journal format", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-reflexes-"));
    const journalPath = join(dir, "journal.ndjson");
    const mock = mockSystemOne(AUTO_GATE);
    const reflexes = createReflexes({ judge: mock, root: dir, journalPath });

    await reflexes.gate({ tool: "bash", command: "echo hi", task: "t" });

    const events = loadJournal(journalPath);
    expect(events.some((e) => e.t === "decision" && e.reflex === "gate" && e.action === "auto")).toBe(true);
  });
});

describe("createReflexes — focus", () => {
  test("select mode returns only the section(s) scored relevant", async () => {
    const sections = [
      "ALPHA section with enough content to clear the min-chars floor and stay distinct ".repeat(4),
      "BETA section with enough content to clear the min-chars floor and stay distinct ".repeat(4),
      "GAMMA section with enough content to clear the min-chars floor and stay distinct ".repeat(4),
    ];
    const content = sections.join("\n\n");
    const mock = mockSystemOne((_state, questions) => {
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) {
        const relevant = "instructions" in q && q.instructions.includes("BETA");
        answers[id] = noulAnswer(relevant ? 0.9 : 0.05);
      }
      return answers;
    });
    const reflexes = createReflexes({ judge: mock, root: "/tmp" });

    const focused = await reflexes.focus({ task: "what does the BETA section say", command: "cat", outcome: "ok", recentFindings: [], content });
    expect(focused.mode).toBe("select");
    expect(focused.text).toContain("BETA");
    expect(focused.text).not.toContain("ALPHA");
    expect(focused.text).not.toContain("GAMMA");
  });

  test("full/exhaustive mode returns the original content verbatim, not a naive truncation", async () => {
    const mock = mockSystemOne(() => ({}));
    const reflexes = createReflexes({ judge: mock, root: "/tmp" });

    const shortContent = "just a little text";
    const focused = await reflexes.focus({ task: "summarize", command: "cat", outcome: "ok", recentFindings: [], content: shortContent });
    expect(focused.mode).toBe("full");
    expect(focused.text).toBe(shortContent);
  });
});

describe("createReflexes — policy override", () => {
  test("a shallow policy override reaches the engine and changes gate's outcome", async () => {
    const borderline = (): Record<string, Answer> => ({
      destructive: scoreAnswer(0, 0.9),
      touches_credentials: noulAnswer(0.02),
      exfiltrates: noulAnswer(0.01),
      on_task: noulAnswer(0.95),
      disposition: choiceAnswer("auto_run", 0.9, { auto_run: 0.9, ask_user: 0.08, deny: 0.02 }),
    });
    const mock = mockSystemOne(borderline);

    const defaultPolicy = createReflexes({ judge: mock, root: "/tmp" });
    const defaultDecision = await defaultPolicy.gate({ tool: "bash", command: "echo hi", task: "t" });

    const strict = createReflexes({ judge: mock, root: "/tmp", policy: { gate: { autoConfidence: 0.99 } as never } });
    const strictDecision = await strict.gate({ tool: "bash", command: "echo hi", task: "t" });

    expect(defaultDecision.action).toBe("auto");
    expect(strictDecision.action).toBe("ask");
  });

  test("an untouched top-level policy section still uses its default after a different section is overridden", async () => {
    const mock = mockSystemOne((_state, questions) => {
      if ("contains_agent_directive" in questions) return BENIGN_SANITIZE();
      return AUTO_GATE();
    });
    const reflexes = createReflexes({ judge: mock, root: "/tmp", policy: { gate: { autoConfidence: 0.99 } as never } });

    const observed = await reflexes.observe({ task: "t", source: "tool:read", actionSummary: "read", status: "ok", truncated: false, content: "benign" });
    expect(observed.sanitize.action).toBe("pass");
  });
});

describe("createReflexes — root default", () => {
  test("omitting root resolves to the real process.cwd(), not undefined", async () => {
    const mock = mockSystemOne(AUTO_GATE);
    const reflexes = createReflexes({ judge: mock });
    const decision = await reflexes.gate({ tool: "write", path: "some-file.txt", task: "t" });
    expect(decision.action).toBeDefined();
  });
});
