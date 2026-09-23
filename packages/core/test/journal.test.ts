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
    journal.append({
      t: "decision",
      v: 2,
      judgmentId: "j_a",
      ts: 4,
      reflex: "gate",
      action: "auto",
      reasons: ["disposition auto_run at confidence 0.95"],
    });
    journal.append({
      t: "tool_observation",
      v: 2,
      toolCallId: "tc1",
      turnId: "turn_a",
      ts: 5,
      observation: {
        toolCallId: "tc1",
        tool: "bash",
        argsSummary: { command: "npm test" },
        status: "ok",
        exitCode: 1,
        durationMs: 2100,
        excerpt: "1 failing",
        truncated: false,
      },
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
      {
        t: "approval",
        v: 2,
        approvalId: "appr_1",
        ts: 2,
        status: "requested",
        taskId: "task_f",
        toolCallId: "tc9",
        actionHash: "abc",
        reasons: ["ask"],
      },
      { t: "artifacts", v: 2, artifactId: "art_1", ts: 3, toolCallId: "tc9", contentHash: "h", captureComplete: true, byteCount: 12 },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const events = loadJournal(path);
    expect(events.map((e) => e.t)).toEqual(["session_start", "approval", "artifacts"]);
    expect(events[1]?.t === "approval" && events[1].status).toBe("requested");
    expect(events[2]?.t === "artifacts" && events[2].captureComplete).toBe(true);
  });

  test("artifacts event round-trips the F2 focus fields, and a legacy shape without them still parses", () => {
    const path = tmpPath("focus-fields.ndjson");
    const withFocus = {
      t: "artifacts",
      v: 2,
      artifactId: "art_2",
      ts: 4,
      toolCallId: "tc10",
      contentHash: "h2",
      captureComplete: true,
      byteCount: 500,
      sectionManifestHash: "sect_hash",
      focusRollout: "on",
      focusMode: "select",
      focusStatus: "ok",
    };
    const legacy = {
      t: "artifacts",
      v: 2,
      artifactId: "art_3",
      ts: 5,
      toolCallId: "tc11",
      contentHash: "h3",
      captureComplete: false,
      byteCount: 10,
    };
    writeFileSync(path, [withFocus, legacy].map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const events = loadJournal(path);
    const first = events[0];
    expect(first?.t === "artifacts" && first.focusRollout).toBe("on");
    expect(first?.t === "artifacts" && first.focusMode).toBe("select");
    expect(first?.t === "artifacts" && first.focusStatus).toBe("ok");
    expect(first?.t === "artifacts" && first.sectionManifestHash).toBe("sect_hash");

    const second = events[1];
    expect(second?.t === "artifacts" && second.focusRollout).toBeUndefined();
    expect(second?.t === "artifacts" && second.captureComplete).toBe(false);
  });

  test("reflex event round-trips the P10 cache-provenance fields, and a fresh (non-cached) reflex omits them", () => {
    const path = tmpPath("cache-fields.ndjson");
    const cached = {
      t: "reflex",
      v: 2,
      sessionId: "sess_b",
      judgmentId: "j_new",
      ts: 6,
      reflex: "gate",
      subject: "npm test",
      status: "completed",
      state: {},
      questions: {},
      result: { model: "jev-1.13.0", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 }, answers: {} },
      cacheHit: true,
      cachedFromJudgmentId: "j_old",
    };
    const fresh = {
      t: "reflex",
      v: 2,
      sessionId: "sess_b",
      judgmentId: "j_old",
      ts: 5,
      reflex: "gate",
      subject: "npm test",
      status: "completed",
      state: {},
      questions: {},
      result: { model: "jev-1.13.0", latencyMs: 180, usage: { inputTokens: 800, outputTokens: 0 }, answers: {} },
    };
    writeFileSync(path, [fresh, cached].map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const events = loadJournal(path);
    const first = events[0];
    const second = events[1];
    expect(first?.t === "reflex" && first.cacheHit).toBeUndefined();
    expect(second?.t === "reflex" && second.cacheHit).toBe(true);
    expect(second?.t === "reflex" && second.cachedFromJudgmentId).toBe("j_old");
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

  test("capability_set event round-trips through loadJournal", () => {
    const path = tmpPath("capability_set.ndjson");
    const journal = openJournal(path);
    journal.append({
      t: "capability_set",
      v: 2,
      ts: 1,
      taskId: "task_a",
      turnId: "turn_a",
      catalogHash: "cat123",
      activeIds: ["tool:bash", "skill:verify"],
      instructionHash: "inst456",
    });

    const events = loadJournal(path);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      t: "capability_set",
      v: 2,
      ts: 1,
      taskId: "task_a",
      turnId: "turn_a",
      catalogHash: "cat123",
      activeIds: ["tool:bash", "skill:verify"],
      instructionHash: "inst456",
    });
  });
});
