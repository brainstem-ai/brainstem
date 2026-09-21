import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, type ArtifactMeta } from "@brainstem/core";
import { LocalArtifactStore } from "../src/output/artifact-store";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function meta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  const i = metaCounter++;
  return {
    artifactId: `art_${String(i).padStart(3, "0")}`,
    toolCallId: `tc${i}`,
    tool: "bash",
    commandOrTarget: `echo ${i}`,
    contentHash: contentHash(`content-${i}`),
    byteCount: 0,
    lineCount: 1,
    captureComplete: true,
    createdAt: i,
    ...overrides,
  };
}
let metaCounter = 0;

describe("LocalArtifactStore", () => {
  test("put/get round-trips meta and content exactly", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"));
    const record = meta({ artifactId: "art_x", byteCount: 7, lineCount: 1 });
    store.put(record, "a\nb\nc");
    const entry = store.get("art_x");
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("a\nb\nc");
    expect(entry!.meta).toMatchObject({
      artifactId: "art_x",
      toolCallId: record.toolCallId,
      contentHash: record.contentHash,
      byteCount: 7,
      lineCount: 1,
      captureComplete: true,
    });
    expect(entry!.meta.evicted).toBeUndefined();
    expect(store.get("art_missing")).toBeNull();
  });

  test("list() returns every artifact sorted by createdAt, including evicted", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), { maxArtifacts: 1 });
    store.put(meta({ artifactId: "art_b", createdAt: 20 }), "b");
    store.put(meta({ artifactId: "art_a", createdAt: 10 }), "a");
    store.put(meta({ artifactId: "art_c", createdAt: 30 }), "c");
    const ids = store.list().map((m) => m.artifactId);
    expect(ids).toEqual(["art_a", "art_b", "art_c"]);
    expect(store.list().find((m) => m.artifactId === "art_a")?.evicted).toBe(true);
  });

  test("evicts oldest by createdAt beyond maxArtifacts and keeps expired meta", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), { maxArtifacts: 2 });
    store.put(meta({ artifactId: "art_old", createdAt: 1 }), "old");
    store.put(meta({ artifactId: "art_mid", createdAt: 2 }), "mid");
    store.put(meta({ artifactId: "art_new", createdAt: 3 }), "new");
    store.put(meta({ artifactId: "art_newest", createdAt: 4 }), "newest");

    const oldEntry = store.get("art_old");
    expect(oldEntry).not.toBeNull();
    expect(oldEntry!.content).toBeNull();
    expect(oldEntry!.meta.evicted).toBe(true);
    expect(existsSync(join(dir, "artifacts", "art_old.txt"))).toBe(false);
    expect(existsSync(join(dir, "artifacts", "art_old.json"))).toBe(true);

    expect(store.get("art_mid")!.content).toBeNull();
    expect(store.get("art_mid")!.meta.evicted).toBe(true);
    expect(store.get("art_new")!.content).toBe("new");
    expect(store.get("art_newest")!.content).toBe("newest");

    const reopened = new LocalArtifactStore(join(dir, "artifacts"));
    expect(reopened.get("art_old")!.content).toBeNull();
    expect(reopened.get("art_old")!.meta.evicted).toBe(true);
  });

  test("evicts by total byte limit", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), { maxTotalBytes: 10 });
    store.put(meta({ artifactId: "art_big", createdAt: 1, byteCount: 9 }), "x".repeat(9));
    store.put(meta({ artifactId: "art_small", createdAt: 2, byteCount: 2 }), "yy");
    expect(store.get("art_big")!.meta.evicted).toBe(true);
    expect(store.get("art_small")!.content).toBe("yy");
  });

  test("put is rename-atomic: no temp files survive and content is intact", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"));
    store.put(meta({ artifactId: "art_torn" }), "precise content");
    const names = readdirSync(join(dir, "artifacts")).sort();
    expect(names).toEqual(["art_torn.json", "art_torn.txt"]);
    expect(names.every((n) => !n.includes(".tmp"))).toBe(true);
    expect(store.get("art_torn")!.content).toBe("precise content");
  });

  test("enforces both limits together without evicting the fresh capture first", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-artifacts-"));
    const store = new LocalArtifactStore(join(dir, "artifacts"), { maxArtifacts: 2, maxTotalBytes: 100 });
    store.put(meta({ artifactId: "art_1", createdAt: 1, byteCount: 60 }), "1".repeat(60));
    store.put(meta({ artifactId: "art_2", createdAt: 2, byteCount: 30 }), "2".repeat(30));
    store.put(meta({ artifactId: "art_3", createdAt: 3, byteCount: 5 }), "3".repeat(5));
    expect(store.get("art_1")!.meta.evicted).toBe(true);
    expect(store.get("art_2")!.content).not.toBeNull();
    expect(store.get("art_3")!.content).not.toBeNull();
  });
});
