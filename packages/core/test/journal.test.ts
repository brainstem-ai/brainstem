import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendJournalEvent, loadJournal, openJournal } from "../src/journal";
import { hashAction } from "../src/evidence";
import { policyForTrust } from "../src/policy";

const POLICY = policyForTrust(0.3);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpPath(name: string) {
  const d = mkdtempSync(join(tmpdir(), "brainstem-journal-"));
  dirs.push(d);
  return join(d, name);
}

describe("journal (schema v2)", () => {
  test("round-trips v2 events through NDJSON", () => {
    const path = tmpPath("session.ndjson");
    const journal = openJournal(path);

    journal.append({
      t: "session_start",
      v: 2,
      sessionId: "sess_a",
      ts: 1,
      trust: 0.3,
      policySnapshot: POLICY,
      policyHash: hashAction(POLICY),
    });
    journal.append({ t: "task_start", v: 2, sessionId: "sess_a", taskId: "task_a", ts: 2, objective: "fix the auth test" });
    journal.append({
      t: "reflex",
      v: 2,
      sessionId: "sess_a",
      taskId: "task_a",
      turnId: "turn_a",
      judgmentId: "j_a",
      ts: 3,
      reflex: "gate",
      subject: "npm test",
      status: "completed",
      state: { task: "fix the auth test" },
      questions: { safe: { type: "noul", instructions: "Is it safe?" } },
      result: {
        model: "jev-1.13.0",
        latencyMs: 180,
        usage: { inputTokens: 800, outputTokens: 0 },
        answers: { safe: { type: "noul", noul: 0.05 } },
      },
    });
    journal.append({ t: "decision", v: 2, judgmentId: "j_a", ts: 4, reflex: "gate", action: "auto", reasons: ["disposition auto_run at confidence 0.95"] });
    journal.append({
      t: "tool_observation",
      v: 2,
      toolCallId: "tc1",
      turnId: "turn_a",
      ts: 5,
      observation: { toolCallId: "tc1", tool: "bash", argsSummary: { command: "npm test" }, status: "ok", exitCode: 1, durationMs: 2100, excerpt: "1 failing", truncated: false },
      deliveredExcerpt: "1 failing",
      deliveredTruncated: false,
    });
    journal.append({
      t: "llm_call",
      v: 2,
      turnId: "turn_a",
      ts: 6,
      model: "jev-1.13.0",
      durationMs: 900,
      usage: { input: 800, output: 120, cacheRead: 0, cacheWrite: 0, costTotal: "unknown" },
      firstTokenMs: 210,
    });
    journal.append({ t: "session_end", v: 2, sessionId: "sess_a", ts: 7, reason: "normal" });

    const events = loadJournal(path);
    expect(events).toHaveLength(7);
    expect(events[0]).toEqual({
      t: "session_start",
      v: 2,
      sessionId: "sess_a",
      ts: 1,
      trust: 0.3,
      policySnapshot: POLICY,
      policyHash: hashAction(POLICY),
    });
    const reflex = events[2]!;
    expect(reflex.t === "reflex" && reflex.judgmentId).toBe("j_a");
    expect(reflex.t === "reflex" && reflex.status).toBe("completed");
    expect(reflex.t === "reflex" && reflex.result?.answers.safe).toEqual({ type: "noul", noul: 0.05 });
    const llm = events[5]!;
    expect(llm.t === "llm_call" && llm.usage.costTotal).toBe("unknown");
    expect(events[6]).toEqual({ t: "session_end", v: 2, sessionId: "sess_a", ts: 7, reason: "normal" });
  });

  test("loadJournal round-trips a written v2 fixture file", () => {
    const path = tmpPath("fixture.ndjson");
    const policy = policyForTrust(0.5);
    const lines = [
      { t: "session_start", v: 2, sessionId: "sess_f", ts: 1, trust: 0.5, policySnapshot: policy, policyHash: hashAction(policy) },
      { t: "approval", v: 2, approvalId: "appr_1", ts: 2, status: "requested", taskId: "task_f", toolCallId: "tc9", actionHash: "abc", reasons: ["ask"] },
      { t: "artifacts", v: 2, artifactId: "art_1", ts: 3, toolCallId: "tc9", contentHash: "h", captureComplete: true, byteCount: 12 },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const events = loadJournal(path);
    expect(events.map((e) => e.t)).toEqual(["session_start", "approval", "artifacts"]);
    expect(events[1]?.t === "approval" && events[1].status).toBe("requested");
    expect(events[2]?.t === "artifacts" && events[2].captureComplete).toBe(true);
  });

  test("loadJournal throws a clear error on unknown schema versions", () => {
    const path = tmpPath("v1.ndjson");
    writeFileSync(path, JSON.stringify({ t: "session_start", ts: 1, trust: 0.3 }) + "\n", "utf8");
    expect(() => loadJournal(path)).toThrow(/unknown journal schema version/i);

    const v3 = tmpPath("v3.ndjson");
    writeFileSync(v3, JSON.stringify({ t: "session_start", v: 3, ts: 1, trust: 0.3 }) + "\n", "utf8");
    expect(() => loadJournal(v3)).toThrow(/unknown journal schema version 3/i);
  });

  test("appending to an existing journal preserves earlier events", () => {
    const path = tmpPath("session.ndjson");
    openJournal(path).append({ t: "session_end", v: 2, sessionId: "s", ts: 1, reason: "normal" });
    openJournal(path).append({ t: "session_end", v: 2, sessionId: "s", ts: 2, reason: "normal" });

    expect(loadJournal(path)).toHaveLength(2);
  });

  test("appendJournalEvent is mkdir-safe for standalone use", () => {
    const path = tmpPath("nested/oneshot.ndjson");
    appendJournalEvent(path, { t: "session_end", v: 2, sessionId: "s", ts: 7, reason: "normal" });
    expect(loadJournal(path)).toHaveLength(1);
  });

  test("openJournal mkdirs once at open and append does not re-mkdir", () => {
    const dir = mkdtempSync(join(tmpdir(), "brainstem-journal-"));
    dirs.push(dir);
    const path = join(dir, "log", "session.ndjson");
    const journal = openJournal(path);
    journal.append({ t: "session_end", v: 2, sessionId: "s", ts: 1, reason: "normal" });
    expect(loadJournal(path)).toHaveLength(1);

    rmSync(dirname(path), { recursive: true, force: true });
    expect(() => journal.append({ t: "session_end", v: 2, sessionId: "s", ts: 2, reason: "normal" })).toThrow();
  });
});
