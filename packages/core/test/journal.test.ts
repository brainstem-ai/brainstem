import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournalEvent, loadJournal, openJournal } from "../src/journal";

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

describe("journal", () => {
  test("round-trips events through NDJSON", () => {
    const path = tmpPath("session.ndjson");
    const journal = openJournal(path);

    journal.append({ t: "session_start", ts: 1, trust: 0.3 });
    journal.append({ t: "user_message", ts: 2, text: "fix the auth test" });
    journal.append({
      t: "reflex",
      ts: 3,
      reflex: "gate",
      subject: "npm test",
      state: { task: "fix the auth test" },
      questions: { safe: { type: "noul", instructions: "Is it safe?" } },
      result: {
        model: "jev-1.13.0",
        latencyMs: 180,
        usage: { inputTokens: 800, outputTokens: 0 },
        answers: { safe: { type: "noul", noul: 0.05 } },
      },
    });
    journal.append({ t: "decision", ts: 4, reflex: "gate", action: "auto", reasons: ["disposition auto_run at confidence 0.95"] });
    journal.append({ t: "session_end", ts: 5 });

    const events = loadJournal(path);
    expect(events).toHaveLength(5);
    expect(events[0]).toEqual({ t: "session_start", ts: 1, trust: 0.3 });
    expect(events[2]?.t === "reflex" && events[2].result.answers.safe).toEqual({ type: "noul", noul: 0.05 });
    expect(events[4]).toEqual({ t: "session_end", ts: 5 });
  });

  test("appending to an existing journal preserves earlier events", () => {
    const path = tmpPath("session.ndjson");
    openJournal(path).append({ t: "session_start", ts: 1, trust: 0.5 });
    openJournal(path).append({ t: "session_end", ts: 2 });

    expect(loadJournal(path)).toHaveLength(2);
  });

  test("appendJournalEvent writes without holding a handle", () => {
    const path = tmpPath("oneshot.ndjson");
    appendJournalEvent(path, { t: "session_start", ts: 7, trust: 0.1 });
    appendJournalEvent(path, { t: "session_end", ts: 8 });
    expect(loadJournal(path)).toHaveLength(2);
  });
});
