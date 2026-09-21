import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashAction, loadJournal, openJournal, policyForTrust, type JournalEvent } from "@brainstem/core";
import { SessionRecorder } from "../src/session";

const POLICY = policyForTrust(0.3);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function recorderWith() {
  dir = mkdtempSync(join(tmpdir(), "brainstem-session-"));
  const journalPath = join(dir, "session.ndjson");
  const journal = openJournal(journalPath);
  return { journalPath, recorder: new SessionRecorder(journal, dir, { policy: POLICY, trust: 0.3 }) };
}

describe("SessionRecorder", () => {
  test("records session_start with policy snapshot and hash", () => {
    const { journalPath, recorder } = recorderWith();
    const events = loadJournal(journalPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      t: "session_start",
      v: 2,
      sessionId: recorder.sessionId,
      trust: 0.3,
      policySnapshot: POLICY,
      policyHash: hashAction(POLICY),
    });
  });

  test("task lifecycle: start, updates bump revisions", () => {
    const { journalPath, recorder } = recorderWith();
    const task = recorder.startTask("fix the auth test");
    expect(task.revision).toBe(1);
    expect(task.updates).toEqual([]);

    recorder.updateTask("only the flaky one");
    recorder.updateTask("skip e2e for now");

    expect(recorder.currentTask?.revision).toBe(3);
    expect(recorder.currentTask?.updates).toEqual(["only the flaky one", "skip e2e for now"]);

    const events = loadJournal(journalPath);
    const updates = events.filter((e): e is Extract<JournalEvent, { t: "task_update" }> => e.t === "task_update");
    expect(updates.map((u) => u.revision)).toEqual([2, 3]);
    expect(updates[0]?.taskId).toBe(task.id);
  });

  test("turns record per-turn model calls and durations", () => {
    const { journalPath, recorder } = recorderWith();
    recorder.startTask("t");
    recorder.beginTurn();
    recorder.recordModelCall();
    recorder.recordModelCall();
    recorder.endTurn({ jevMs: 12, modelMs: 340 });
    recorder.beginTurn();
    recorder.endTurn();

    const events = loadJournal(journalPath);
    const turnEnds = events.filter((e): e is Extract<JournalEvent, { t: "turn_end" }> => e.t === "turn_end");
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]?.modelCalls).toBe(2);
    expect(turnEnds[0]?.spans).toEqual({ jevMs: 12, modelMs: 340 });
    expect(turnEnds[1]?.modelCalls).toBe(0);
    expect(turnEnds[1]?.spans).toBeUndefined();
    expect(turnEnds[0]?.turnId).not.toBe(turnEnds[1]?.turnId);
  });

  test("cost sums known costs only and stays unknown once anything is unknown", () => {
    const { recorder } = recorderWith();
    expect(recorder.totalCost).toBe(0);
    recorder.recordCost(0.01);
    expect(recorder.totalCost).toBe(0.01);
    recorder.recordCost("unknown");
    expect(recorder.totalCost).toBe("unknown");
  });

  test("repeatedActionCounts and elapsedMs", () => {
    const { recorder } = recorderWith();
    recorder.recordAction("aaa");
    recorder.recordAction("aaa");
    recorder.recordAction("bbb");
    expect(recorder.repeatedActionCounts.get("aaa")).toBe(2);
    expect(recorder.repeatedActionCounts.get("bbb")).toBe(1);
    expect(recorder.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("recentActivity renders actual commands and paths", () => {
    const { recorder } = recorderWith();
    recorder.recordObservation({
      toolCallId: "tc1",
      tool: "bash",
      argsSummary: { command: "npm test" },
      status: "ok",
      exitCode: 1,
      durationMs: 2100,
      excerpt: "",
      truncated: false,
    });
    recorder.recordObservation({
      toolCallId: "tc2",
      tool: "write",
      argsSummary: { path: "src/auth.ts" },
      status: "ok",
      durationMs: 4,
      excerpt: "",
      truncated: false,
    });
    recorder.recordObservation({
      toolCallId: "tc3",
      tool: "bash",
      argsSummary: { command: "rm -rf /" },
      status: "blocked",
      durationMs: 0,
      excerpt: "",
      truncated: false,
    });

    expect(recorder.recentActivity(2)).toEqual([
      "write: src/auth.ts (ok, 0.0s)",
      "bash: rm -rf / (blocked)",
    ]);
    expect(recorder.recentActivity(5)[0]).toBe("bash: npm test (exit 1, 2.1s)");
  });

  test("endSession writes session_end with reason and optional error", () => {
    const { journalPath, recorder } = recorderWith();
    recorder.endSession("normal");
    recorder.endSession("error", "boom");
    const events = loadJournal(journalPath);
    const ends = events.filter((e): e is Extract<JournalEvent, { t: "session_end" }> => e.t === "session_end");
    expect(ends[0]).toEqual({ t: "session_end", v: 2, sessionId: recorder.sessionId, ts: ends[0]!.ts, reason: "normal" });
    expect(ends[1]?.reason).toBe("error");
    expect(ends[1]?.error).toBe("boom");
  });

  test("round-trips a full recorded session through loadJournal", () => {
    const { journalPath, recorder } = recorderWith();
    const task = recorder.startTask("ship it");
    recorder.beginTurn();
    recorder.recordModelCall();
    recorder.recordObservation({
      toolCallId: "tc1",
      tool: "bash",
      argsSummary: { command: "bun test" },
      status: "ok",
      exitCode: 0,
      durationMs: 900,
      excerpt: "87 pass",
      truncated: false,
    });
    recorder.endTurn({ toolMs: 900 });
    recorder.updateTask("ship it faster");
    recorder.endSession("normal");

    const events = loadJournal(journalPath);
    expect(events.map((e) => e.t)).toEqual([
      "session_start",
      "task_start",
      "turn_start",
      "turn_end",
      "task_update",
      "session_end",
    ]);
    const taskStart = events.find((e): e is Extract<JournalEvent, { t: "task_start" }> => e.t === "task_start");
    expect(taskStart?.taskId).toBe(task.id);
    expect(taskStart?.sessionId).toBe(recorder.sessionId);
  });
});
