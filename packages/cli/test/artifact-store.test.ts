import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_SCHEMA_VERSION, contentHash, newId, type ArtifactMeta } from "@brainstem/core";
import { LocalArtifactStore } from "../src/output/artifact-store";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const SESSION_A = "sess_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION_B = "sess_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function meta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  const i = metaCounter++;
  return {
    artifactId: newId("art"),
    sessionId: SESSION_A,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    toolCallId: `tc${i}`,
    tool: "bash",
    commandOrTarget: `echo ${i}`,
    contentHash: contentHash(`content-${i}`),
    byteCount: 0,
    lineCount: 1,
    captureComplete: true,
    createdAt: i,
    streams: { output: { bytesObserved: 0, bytesRetained: 0, complete: true } },
    ...overrides,
  };
}
let metaCounter = 0;

describe("LocalArtifactStore", () => {
  test("put/get round-trips meta and content exactly", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A);
    const id = newId("art");
    const record = meta({ artifactId: id, byteCount: 5, lineCount: 3 });
    store.put(record, { output: "a\nb\nc" });
    const entry = store.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toEqual({ output: "a\nb\nc" });
    expect(entry!.meta).toMatchObject({
      artifactId: id,
      sessionId: SESSION_A,
      toolCallId: record.toolCallId,
      contentHash: record.contentHash,
      byteCount: 5,
      lineCount: 3,
      captureComplete: true,
    });
    expect(entry!.meta.evicted).toBeUndefined();
    expect(store.get(newId("art"))).toBeNull();
  });

  test("stores stdout and stderr as separate named streams", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A);
    const id = newId("art");
    store.put(
      meta({
        artifactId: id,
        byteCount: 11,
        streams: {
          stdout: { bytesObserved: 5, bytesRetained: 5, complete: true },
          stderr: { bytesObserved: 6, bytesRetained: 6, complete: true },
        },
      }),
      { stdout: "stdout content", stderr: "stderr content" },
    );
    const entry = store.get(id);
    expect(entry!.content).toEqual({ stdout: "stdout content", stderr: "stderr content" });
  });

  test("list() returns every artifact sorted by createdAt, including evicted", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A, { maxArtifacts: 1 });
    const [idB, idA, idC] = [newId("art"), newId("art"), newId("art")];
    store.put(meta({ artifactId: idB, createdAt: 20 }), { output: "b" });
    store.put(meta({ artifactId: idA, createdAt: 10 }), { output: "a" });
    store.put(meta({ artifactId: idC, createdAt: 30 }), { output: "c" });
    const ids = store.list().map((m) => m.artifactId);
    expect(ids).toEqual([idA, idB, idC]);
    expect(store.list().find((m) => m.artifactId === idA)?.evicted).toBe(true);
  });

  test("evicts oldest by createdAt beyond maxArtifacts and keeps expired meta", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A, { maxArtifacts: 2 });
    const [idOld, idMid, idNew, idNewest] = [newId("art"), newId("art"), newId("art"), newId("art")];
    store.put(meta({ artifactId: idOld, createdAt: 1 }), { output: "old" });
    store.put(meta({ artifactId: idMid, createdAt: 2 }), { output: "mid" });
    store.put(meta({ artifactId: idNew, createdAt: 3 }), { output: "new" });
    store.put(meta({ artifactId: idNewest, createdAt: 4 }), { output: "newest" });

    const oldEntry = store.get(idOld);
    expect(oldEntry).not.toBeNull();
    expect(oldEntry!.content).toBeNull();
    expect(oldEntry!.meta.evicted).toBe(true);
    expect(existsSync(join(dir, "artifacts", `${idOld}.output.txt`))).toBe(false);
    expect(existsSync(join(dir, "artifacts", `${idOld}.json`))).toBe(true);

    expect(store.get(idMid)!.content).toBeNull();
    expect(store.get(idMid)!.meta.evicted).toBe(true);
    expect(store.get(idNew)!.content).toEqual({ output: "new" });
    expect(store.get(idNewest)!.content).toEqual({ output: "newest" });

    const reopened = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A);
    expect(reopened.get(idOld)!.content).toBeNull();
    expect(reopened.get(idOld)!.meta.evicted).toBe(true);
  });

  test("evicts by total byte limit", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A, { maxTotalBytes: 10 });
    const [idBig, idSmall] = [newId("art"), newId("art")];
    store.put(meta({ artifactId: idBig, createdAt: 1, byteCount: 9 }), { output: "x".repeat(9) });
    store.put(meta({ artifactId: idSmall, createdAt: 2, byteCount: 2 }), { output: "yy" });
    expect(store.get(idBig)!.meta.evicted).toBe(true);
    expect(store.get(idSmall)!.content).toEqual({ output: "yy" });
  });

  test("put is rename-atomic: no temp files survive and content is intact", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A);
    const id = newId("art");
    store.put(meta({ artifactId: id }), { output: "precise content" });
    const names = readdirSync(join(dir, "artifacts")).sort();
    expect(names).toEqual([`${id}.json`, `${id}.output.txt`, "session.json"]);
    expect(names.every((n) => !n.includes(".tmp"))).toBe(true);
    expect(store.get(id)!.content).toEqual({ output: "precise content" });
  });

  test("enforces both limits together without evicting the fresh capture first", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A, { maxArtifacts: 2, maxTotalBytes: 100 });
    const [id1, id2, id3] = [newId("art"), newId("art"), newId("art")];
    store.put(meta({ artifactId: id1, createdAt: 1, byteCount: 60 }), { output: "1".repeat(60) });
    store.put(meta({ artifactId: id2, createdAt: 2, byteCount: 30 }), { output: "2".repeat(30) });
    store.put(meta({ artifactId: id3, createdAt: 3, byteCount: 5 }), { output: "3".repeat(5) });
    expect(store.get(id1)!.meta.evicted).toBe(true);
    expect(store.get(id2)!.content).not.toBeNull();
    expect(store.get(id3)!.content).not.toBeNull();
  });
});

describe("R7: session isolation", () => {
  test("two sessions with stores under the same parent directory cannot read each other's artifacts", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-r7-"));
    const storeA = new LocalArtifactStore(join(dir, "sessions", SESSION_A, "artifacts"), SESSION_A);
    const storeB = new LocalArtifactStore(join(dir, "sessions", SESSION_B, "artifacts"), SESSION_B);
    const idA = newId("art");
    storeA.put(meta({ artifactId: idA, sessionId: SESSION_A }), { output: "session A secret" });

    expect(storeA.get(idA)!.content).toEqual({ output: "session A secret" });
    // Session B never sees session A's artifact, even though it knows the id.
    expect(storeB.get(idA)).toBeNull();
    expect(storeB.list()).toEqual([]);
  });

  test("exhausting one session's store does not evict another session's artifacts", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-r7-"));
    const storeA = new LocalArtifactStore(join(dir, "sessions", SESSION_A, "artifacts"), SESSION_A, { maxArtifacts: 1 });
    const storeB = new LocalArtifactStore(join(dir, "sessions", SESSION_B, "artifacts"), SESSION_B, { maxArtifacts: 1 });
    const idB = newId("art");
    storeB.put(meta({ artifactId: idB, sessionId: SESSION_B }), { output: "B content" });

    for (let i = 0; i < 5; i++) {
      storeA.put(meta({ artifactId: newId("art"), sessionId: SESSION_A, createdAt: i }), { output: `A-${i}` });
    }

    expect(storeB.get(idB)!.content).toEqual({ output: "B content" });
    expect(storeB.get(idB)!.meta.evicted).toBeUndefined();
  });

  test("reopening a store for its original session preserves its artifacts", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-r7-"));
    const sessionDir = join(dir, "sessions", SESSION_A, "artifacts");
    const id = newId("art");
    new LocalArtifactStore(sessionDir, SESSION_A).put(meta({ artifactId: id, sessionId: SESSION_A }), { output: "persisted" });

    const reopened = new LocalArtifactStore(sessionDir, SESSION_A);
    expect(reopened.get(id)!.content).toEqual({ output: "persisted" });
  });

  test("reopening the same directory for a DIFFERENT session id is refused", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-r7-"));
    const sessionDir = join(dir, "sessions", SESSION_A, "artifacts");
    new LocalArtifactStore(sessionDir, SESSION_A);
    expect(() => new LocalArtifactStore(sessionDir, SESSION_B)).toThrow(/belongs to session/);
  });

  test("forged ownership metadata (sessionId mismatch on disk) is never served", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-r7-"));
    const sessionDir = join(dir, "sessions", SESSION_A, "artifacts");
    const store = new LocalArtifactStore(sessionDir, SESSION_A);
    const id = newId("art");
    // Bypass the store's own put() to simulate corrupted/forged metadata
    // written directly to disk with a foreign sessionId.
    const forged = meta({ artifactId: id, sessionId: SESSION_B });
    writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify(forged));
    writeFileSync(join(sessionDir, `${id}.output.txt`), "forged content");

    const reopened = new LocalArtifactStore(sessionDir, SESSION_A);
    expect(reopened.get(id)).toBeNull();
    expect(reopened.list()).toEqual([]);
  });

  test("malformed artifact ids are rejected before any path is derived", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-r7-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A);
    for (const bad of ["../../../etc/passwd", "art_not-a-uuid", "", "art_" + "a".repeat(36)]) {
      expect(store.get(bad)).toBeNull();
    }
    expect(() => store.put(meta({ artifactId: "../../../etc/passwd" }), { output: "x" })).toThrow(/malformed id/);
    // Nothing escaped the store directory.
    expect(existsSync(join(dir, "etc", "passwd"))).toBe(false);
  });

  test("corrupt metadata on disk (unparseable JSON) is skipped, not thrown, on load", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-r7-"));
    const sessionDir = join(dir, "artifacts");
    new LocalArtifactStore(sessionDir, SESSION_A);
    writeFileSync(join(sessionDir, `${newId("art")}.json`), "{not valid json");
    expect(() => new LocalArtifactStore(sessionDir, SESSION_A)).not.toThrow();
  });

  test("tombstones are bounded by a retention horizon; beyond it, a purged id reports unknown", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-r7-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), SESSION_A, { maxArtifacts: 1, maxTombstones: 2 });
    const ids = Array.from({ length: 5 }, () => newId("art"));
    ids.forEach((id, i) => store.put(meta({ artifactId: id, createdAt: i }), { output: `v${i}` }));

    // Only the most recent 2 tombstones (of the 4 evicted) survive; the rest
    // are purged entirely and report as unknown rather than expired.
    const live = store.get(ids[4]!);
    expect(live!.content).not.toBeNull();
    const purged = store.get(ids[0]!);
    expect(purged).toBeNull();
  });
});
