import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_SCHEMA_VERSION, newId, type ArtifactMeta } from "@brainstem/core";
import { LocalArtifactStore } from "../src/output/artifact-store";
import { makeRecoveryTools } from "../src/output/recovery-tools";

const SESSION = "sess_cccccccc-cccc-cccc-cccc-cccccccccccc";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function setup() {
  dir = mkdtempSync(join(tmpdir(), "brainstem-recovery-tools-"));
  const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION);
  const [readOutput, searchOutput] = makeRecoveryTools({ store });
  return { store, readOutput: readOutput!, searchOutput: searchOutput! };
}

function putArtifact(
  store: LocalArtifactStore,
  content: Record<string, string>,
  overrides: Partial<ArtifactMeta> = {},
): string {
  const id = newId("art");
  const streams: ArtifactMeta["streams"] = {};
  for (const [name, text] of Object.entries(content)) {
    streams[name] = { bytesObserved: Buffer.byteLength(text, "utf8"), bytesRetained: Buffer.byteLength(text, "utf8"), complete: true };
  }
  store.put(
    {
      artifactId: id,
      sessionId: SESSION,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      toolCallId: "tc",
      tool: "bash",
      commandOrTarget: "echo",
      contentHash: "0".repeat(64),
      byteCount: Object.values(content).reduce((s, t) => s + Buffer.byteLength(t, "utf8"), 0),
      lineCount: 0,
      captureComplete: true,
      createdAt: Date.now(),
      streams,
      ...overrides,
    },
    content,
  );
  return id;
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

/**
 * Pages through read_output end to end, following whichever continuation
 * notice a page actually offers (startLine=, with or without an
 * accompanying startByteInLine=), and returns the exact concatenated source
 * text with no gaps or duplicated bytes. Used to verify full recovery
 * regardless of how many pages the implementation happens to need — the
 * point is that pagination terminates and reconstructs exactly, not a
 * specific page count.
 */
async function reconstructRead(
  readOutput: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> },
  id: string,
  opts: { stream?: string; maxPages?: number } = {},
): Promise<string> {
  const maxPages = opts.maxPages ?? 1_000;
  let out = "";
  let startLine = 1;
  let startByteInLine: number | undefined;
  for (let i = 0; i < maxPages; i++) {
    // Resuming mid-line (a byte-range continuation of the SAME line) is the
    // only case where the next chunk is NOT preceded by a line break —
    // every other page (whether it turns out whole-line or immediately
    // starts a new oversized-line byte page) begins a fresh line.
    const resumingMidLine = startByteInLine !== undefined;
    const params: Record<string, unknown> = { id, startLine };
    if (opts.stream !== undefined) params.stream = opts.stream;
    if (resumingMidLine) params.startByteInLine = startByteInLine;
    const result = (await readOutput.execute("x", params)) as {
      content: { text: string }[];
      details: { outcome: string; endLine: number; partialLine?: boolean };
    };
    if (result.details.outcome !== "ok") {
      throw new Error(`reconstructRead: unexpected outcome ${result.details.outcome} at page ${i}`);
    }
    const raw = textOf(result);
    if (raw.includes("(requested range is past the end of the capture)")) {
      return out; // a partial-line completion can legitimately advance one line past the real end
    }
    const lines = raw.split("\n");
    const body = lines.slice(1).join("\n").replace(/\n\[brainstem\].*$/s, "");

    out += resumingMidLine ? body : (out.length > 0 ? "\n" : "") + body;

    if (result.details.partialLine) {
      const m = raw.match(/startByteInLine=(\d+)/);
      if (m) {
        startByteInLine = Number(m[1]);
        startLine = result.details.endLine; // same line, continued
        continue;
      }
      // This line is now complete — advance past it and keep reading any
      // remaining lines, rather than stopping here.
      startByteInLine = undefined;
      startLine = result.details.endLine + 1;
      continue;
    }

    startByteInLine = undefined;
    const m = raw.match(/startLine=(\d+)/);
    if (!m) return out; // no more continuation offered
    const next = Number(m[1]);
    if (next <= startLine) throw new Error(`reconstructRead: no forward progress at page ${i} (startLine stayed ${startLine})`);
    startLine = next;
  }
  throw new Error(`reconstructRead: did not terminate within ${maxPages} pages`);
}

describe("R5/R6: read_output — full recovery, byte-precise pagination, honest receipts", () => {
  test("a 60,000-character capture is recoverable in full via repeated reads, without gaps or duplicated bytes", async () => {
    const { store, readOutput } = setup();
    const lines = Array.from({ length: 3_000 }, (_, i) => `line-${i}`);
    const full = lines.join("\n");
    const id = putArtifact(store, { output: full });

    let reconstructed: string[] = [];
    let startLine = 1;
    for (let guard = 0; guard < 100; guard++) {
      const result = (await readOutput.execute("x", { id, startLine, lineCount: 2_000 })) as {
        content: { text: string }[];
        details: { outcome: string; startLine: number; endLine: number };
      };
      if (result.details.outcome !== "ok") break;
      const body = textOf(result).split("\n").slice(1); // drop the header line
      const withoutContinuation = body.filter((l) => !l.startsWith("[brainstem]"));
      reconstructed.push(...withoutContinuation);
      if (result.details.endLine >= lines.length) break;
      startLine = result.details.endLine + 1;
    }
    expect(reconstructed).toEqual(lines);
  });

  test("a file beyond its capture cap is marked incomplete, not silently presented as complete", async () => {
    const { store, readOutput } = setup();
    const id = putArtifact(
      store,
      { output: "partial content only" },
      { captureComplete: false, streams: { output: { bytesObserved: 500_000, bytesRetained: 21, complete: false } } },
    );
    const result = (await readOutput.execute("x", { id })) as { content: { text: string }[] };
    expect(textOf(result)).toContain("truncated-capture");
  });

  test("stderr-only content is retrievable by explicit stream name, distinct from stdout", async () => {
    const { store, readOutput } = setup();
    const id = putArtifact(store, { stdout: "", stderr: "error line 1\nerror line 2" });

    const stderrResult = (await readOutput.execute("x", { id, stream: "stderr" })) as { content: { text: string }[] };
    expect(textOf(stderrResult)).toContain("error line 1");
    expect(textOf(stderrResult)).toContain("stream stderr");

    const stdoutResult = (await readOutput.execute("x", { id, stream: "stdout" })) as {
      content: { text: string }[];
      details: { outcome: string };
    };
    expect(stdoutResult.details.outcome).toBe("empty");
  });

  test("an unknown stream name is a distinct, explicit outcome that lists the real streams", async () => {
    const { store, readOutput } = setup();
    const id = putArtifact(store, { stdout: "content", stderr: "" });
    const result = (await readOutput.execute("x", { id, stream: "bogus" })) as {
      content: { text: string }[];
      details: { outcome: string };
    };
    expect(result.details.outcome).toBe("unknown-stream");
    expect(textOf(result)).toContain("stdout, stderr");
  });

  test("empty output is preserved as an explicit empty artifact, distinct from unknown/expired", async () => {
    const { store, readOutput } = setup();
    const id = putArtifact(store, { output: "" });
    const result = (await readOutput.execute("x", { id })) as { content: { text: string }[]; details: { outcome: string } };
    expect(result.details.outcome).toBe("empty");
    expect(textOf(result)).toContain("is empty");
  });

  test("a single line far larger than the review budget paginates by byte range, never silently truncated", async () => {
    const { store, readOutput } = setup();
    const bigLine = "y".repeat(9_500);
    const id = putArtifact(store, { output: bigLine });

    const page1 = (await readOutput.execute("x", { id, startLine: 1 })) as {
      content: { text: string }[];
      details: { outcome: string; partialLine?: boolean };
    };
    expect(page1.details.partialLine).toBe(true);
    const text1 = textOf(page1);
    expect(text1).toContain("partial line");
    expect(text1).toContain("startByteInLine=");

    const match = text1.match(/startByteInLine=(\d+)/);
    expect(match).not.toBeNull();
    const resumeAt = Number(match![1]);

    const page2 = (await readOutput.execute("x", { id, startLine: 1, startByteInLine: resumeAt })) as {
      content: { text: string }[];
    };
    const body1 = text1.split("\n").slice(1).join("\n").replace(/\n\[brainstem\].*$/s, "");
    const body2 = textOf(page2).split("\n").slice(1).join("\n").replace(/\n\[brainstem\].*$/s, "");
    expect(body1 + body2).toBe(bigLine);
  });

  test("R6 regression: a multi-line capture whose FIRST line alone exceeds the page budget makes forward progress instead of looping at 'lines 1-0'", async () => {
    const { store, readOutput } = setup();
    const content = "x".repeat(9_000) + "\nsecond line";
    const id = putArtifact(store, { output: content });

    const page1 = (await readOutput.execute("x", { id })) as {
      content: { text: string }[];
      details: { outcome: string; startLine: number; endLine: number; partialLine?: boolean };
    };
    // Must NOT be the old "lines 1-0" zero-progress response.
    expect(page1.details.endLine).toBeGreaterThanOrEqual(page1.details.startLine);
    expect(page1.details.partialLine).toBe(true);

    const full = await reconstructRead(readOutput, id, { maxPages: 20 });
    expect(full).toBe(content);
  });

  test("R6 regression: a line ending exactly at a multi-byte UTF-8 character does not loop forever backing over a complete trailing char", async () => {
    const { store, readOutput } = setup();
    const line = "x".repeat(9_000) + "é"; // 'é' is a complete 2-byte UTF-8 sequence at the very end
    const id = putArtifact(store, { output: line });

    const full = await reconstructRead(readOutput, id, { maxPages: 20 });
    expect(full).toBe(line);
  });

  test("R6: multiline and multi-byte Unicode captures reconstruct exactly regardless of page count", async () => {
    const { store, readOutput } = setup();
    const lines = [
      "first line",
      "x".repeat(8_200), // forces byte pagination on its own
      "línea con acentos: ñ á é í ó ú",
      "🎉".repeat(3_000), // astral (surrogate-pair) characters, well over the page cap in bytes
      "last line",
    ];
    const content = lines.join("\n");
    const id = putArtifact(store, { output: content });

    const full = await reconstructRead(readOutput, id, { maxPages: 50 });
    expect(full).toBe(content);
  });

  test("unknown artifact id and malformed id are both rejected, distinctly from expired", async () => {
    const { readOutput } = setup();
    const unknown = (await readOutput.execute("x", { id: newId("art") })) as { details: { outcome: string } };
    expect(unknown.details.outcome).toBe("unknown");
    const malformed = (await readOutput.execute("x", { id: "../../../etc/passwd" })) as { details: { outcome: string } };
    expect(malformed.details.outcome).toBe("unknown");
  });
});

/**
 * Pages through search_output end to end using its own continuation notice
 * (never a caller-assumed formula like "scannedTo+1", which is WRONG
 * whenever more matches remain within the already-scanned region — e.g.
 * because `limit` capped how many were returned). Returns every delivered
 * match line number in the order received, so a caller can assert exact,
 * gap-free, duplicate-free coverage.
 */
async function reconstructSearchMatches(
  searchOutput: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> },
  id: string,
  pattern: string,
  opts: { limit?: number; maxPages?: number } = {},
): Promise<number[]> {
  const maxPages = opts.maxPages ?? 1_000;
  const found: number[] = [];
  let startLine = 1;
  for (let i = 0; i < maxPages; i++) {
    const params: Record<string, unknown> = { id, pattern, startLine };
    if (opts.limit !== undefined) params.limit = opts.limit;
    const result = (await searchOutput.execute("x", params)) as {
      content: { text: string }[];
      details: { outcome: string };
    };
    if (result.details.outcome !== "ok") throw new Error(`reconstructSearchMatches: unexpected outcome ${result.details.outcome} at page ${i}`);
    const raw = textOf(result);
    for (const m of raw.matchAll(/^(\d+): /gm)) found.push(Number(m[1]));
    const cont = raw.match(/startLine=(\d+)/);
    if (!cont) return found;
    const next = Number(cont[1]);
    if (next <= startLine) throw new Error(`reconstructSearchMatches: no forward progress at page ${i} (startLine stayed ${startLine})`);
    startLine = next;
  }
  throw new Error(`reconstructSearchMatches: did not terminate within ${maxPages} pages`);
}

describe("R6: search_output — cursor coverage and stream awareness", () => {
  test("resuming a search via its own continuation notice recovers every match exactly once, with no gaps or duplicates", async () => {
    const { store, searchOutput } = setup();
    const expectedLines = Array.from({ length: 10 }, (_, i) => i * 50 + 1); // MARK-0 at line 1, MARK-50 at line 51, ...
    const lines = Array.from({ length: 500 }, (_, i) => (i % 50 === 0 ? `MARK-${i}` : `noise-${i}`));
    const id = putArtifact(store, { output: lines.join("\n") });

    const first = (await searchOutput.execute("x", { id, pattern: "^MARK-", limit: 5 })) as {
      details: { totalMatches: number; truncated: boolean; scannedTo: number };
    };
    expect(first.details.truncated).toBe(true);
    expect(first.details.totalMatches).toBe(10);

    const allMatchLines = await reconstructSearchMatches(searchOutput, id, "^MARK-", { limit: 5, maxPages: 20 });
    expect(allMatchLines).toEqual(expectedLines);
    // Exactly once each — no duplicates introduced by an off-by-one resume.
    expect(new Set(allMatchLines).size).toBe(expectedLines.length);
  });

  test("R6 regression: a scan clipped by MAX_SCAN_CHARS reports truthful coverage and the continuation still finds the match beyond it", async () => {
    const { store, searchOutput } = setup();
    // 10,000 lines of 100 chars + a newline (1,010,000 chars total) pushes
    // the needle past searchContent's 1,000,000-char internal scan cap.
    const haystack = ("x".repeat(100) + "\n").repeat(10_000) + "NEEDLE";
    const id = putArtifact(store, { output: haystack });

    const first = (await searchOutput.execute("x", { id, pattern: "NEEDLE" })) as {
      content: { text: string }[];
      details: { outcome: string; totalMatches: number; truncated: boolean; scannedTo: number };
    };
    expect(first.details.totalMatches).toBe(0);
    expect(first.details.truncated).toBe(true);
    // Coverage must be truthful: NOT the full 10,001 lines (that's the bug —
    // claiming full coverage when searchContent internally clipped).
    expect(first.details.scannedTo).toBeLessThan(10_001);
    const text1 = textOf(first);
    expect(text1).toContain("scan bounded by size");

    const cont = text1.match(/startLine=(\d+)/);
    expect(cont).not.toBeNull();
    const second = (await searchOutput.execute("x", { id, pattern: "NEEDLE", startLine: Number(cont![1]) })) as {
      details: { totalMatches: number };
      content: { text: string }[];
    };
    expect(second.details.totalMatches).toBe(1);
    expect(textOf(second)).toContain("NEEDLE");
  });

  test("R6 regression: a match list too large for one page is bounded honestly, and the harness never has to silently re-clip it", async () => {
    const { store, searchOutput } = setup();
    const matchCount = 20;
    const lines = Array.from({ length: matchCount }, (_, i) => `MATCH-${i}: ${"x".repeat(900)}`);
    const id = putArtifact(store, { output: lines.join("\n") });

    const result = (await searchOutput.execute("x", { id, pattern: "MATCH", limit: matchCount })) as {
      content: { text: string }[];
      details: { outcome: string; totalMatches: number; delivered: number };
    };
    // The header's claim of 20 total matches is honest — it's paired with an
    // explicit "page bounded" note, not a silent drop.
    expect(result.details.totalMatches).toBe(matchCount);
    expect(result.details.delivered).toBeLessThan(matchCount);
    const text = textOf(result);
    expect(text).toContain(`${matchCount} match(es) found`);
    expect(text).toContain(`page bounded — showing ${result.details.delivered} of ${matchCount}`);
    expect(text.length).toBeLessThan(8_000); // fits the shared review boundary on its own — no external re-clip needed

    // Every match is still recoverable via the offered continuation, exactly once.
    const allMatchLines = await reconstructSearchMatches(searchOutput, id, "MATCH", { limit: matchCount, maxPages: 20 });
    expect(allMatchLines).toEqual(Array.from({ length: matchCount }, (_, i) => i + 1));
  });

  test("a foreign artifact id / unknown stream for search fails explicitly, not silently empty", async () => {
    const { store, searchOutput } = setup();
    const id = putArtifact(store, { stdout: "hello" });
    const result = (await searchOutput.execute("x", { id, stream: "nope", pattern: "hello" })) as { details: { outcome: string } };
    expect(result.details.outcome).toBe("unknown-stream");
  });

  test("an invalid regex pattern is a distinct error", async () => {
    const { store, searchOutput } = setup();
    const id = putArtifact(store, { output: "content" });
    const result = (await searchOutput.execute("x", { id, pattern: "(unclosed" })) as { details: { outcome: string } };
    expect(result.details.outcome).toBe("invalid-pattern");
  });
});
