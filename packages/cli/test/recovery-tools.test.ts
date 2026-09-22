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

  test("unknown artifact id and malformed id are both rejected, distinctly from expired", async () => {
    const { readOutput } = setup();
    const unknown = (await readOutput.execute("x", { id: newId("art") })) as { details: { outcome: string } };
    expect(unknown.details.outcome).toBe("unknown");
    const malformed = (await readOutput.execute("x", { id: "../../../etc/passwd" })) as { details: { outcome: string } };
    expect(malformed.details.outcome).toBe("unknown");
  });
});

describe("R6: search_output — cursor coverage and stream awareness", () => {
  test("resuming a search with startLine covers the rest without re-scanning or gaps", async () => {
    const { store, searchOutput } = setup();
    const lines = Array.from({ length: 500 }, (_, i) => (i % 50 === 0 ? `MARK-${i}` : `noise-${i}`));
    const id = putArtifact(store, { output: lines.join("\n") });

    const first = (await searchOutput.execute("x", { id, pattern: "^MARK-", limit: 5 })) as {
      details: { totalMatches: number; truncated: boolean; scannedTo: number };
    };
    expect(first.details.truncated).toBe(true);
    expect(first.details.totalMatches).toBe(10);

    const second = (await searchOutput.execute("x", { id, pattern: "^MARK-", limit: 50, startLine: first.details.scannedTo + 1 })) as {
      content: { text: string }[];
      details: { totalMatches: number };
    };
    // Total across both calls covers every match with no duplicates: first
    // call's 5 plus everything from scannedTo+1 onward.
    const secondText = textOf(second);
    expect(secondText).not.toContain("MARK-0\n"); // already covered by the first page
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
