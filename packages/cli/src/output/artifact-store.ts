import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_SCHEMA_VERSION, type ArtifactEntry, type ArtifactMeta, type ArtifactStore } from "@brainstem/core";

export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_ARTIFACTS = 200;
// Retention horizon for tombstones: beyond this many evicted-but-remembered
// entries, the oldest tombstones are purged entirely. Past that point a
// request for that id is reported as unknown, not expired — the store no
// longer has evidence to distinguish the two, and that boundary is the
// documented, honest one.
export const MAX_TOMBSTONES = MAX_ARTIFACTS * 2;

// artifactId format produced by newId("art") in packages/core/src/evidence.ts.
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LocalArtifactStoreOptions {
  maxTotalBytes?: number;
  maxArtifacts?: number;
  maxTombstones?: number;
}

interface SessionManifest {
  sessionId: string;
  root: string;
  schemaVersion: number;
  createdAt: number;
}

/**
 * File-per-artifact store rooted at a session-scoped directory (see R7:
 * docs/plans/2026-09-22-review-remediation.md). Every write goes through a
 * temp file + rename so a crash mid-put can never leave a torn capture:
 * readers see either the previous state or the complete new file.
 *
 * Ownership: every entry is stamped with the constructing session's id and
 * validated on every read; artifact ids are validated against their known
 * format before ever being used to derive a filesystem path.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly #dir: string;
  readonly #sessionId: string;
  readonly #maxTotalBytes: number;
  readonly #maxArtifacts: number;
  readonly #maxTombstones: number;
  readonly #metas = new Map<string, ArtifactMeta>();
  readonly #tombstoneOrder: string[] = [];

  constructor(rootDir: string, sessionId: string, options: LocalArtifactStoreOptions = {}) {
    this.#dir = rootDir;
    this.#sessionId = sessionId;
    this.#maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
    this.#maxArtifacts = options.maxArtifacts ?? MAX_ARTIFACTS;
    this.#maxTombstones = options.maxTombstones ?? MAX_TOMBSTONES;
    mkdirSync(rootDir, { recursive: true });
    this.#loadOrWriteManifest(rootDir, sessionId);

    for (const name of readdirSync(rootDir)) {
      if (!name.endsWith(".json") || name === "session.json") continue;
      let meta: ArtifactMeta;
      try {
        meta = JSON.parse(readFileSync(join(rootDir, name), "utf8")) as ArtifactMeta;
      } catch {
        // A metadata file only exists after its rename completed; an unparseable
        // file is crash debris without a matching content file — skip it.
        continue;
      }
      if (typeof meta.artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(meta.artifactId)) continue;
      if (meta.schemaVersion !== ARTIFACT_SCHEMA_VERSION) continue; // incompatible shape from a prior version — not loaded
      if (meta.sessionId !== sessionId) continue; // foreign metadata (should not happen given the session-scoped directory, but never trusted implicitly)
      this.#metas.set(meta.artifactId, meta);
      if (meta.evicted) this.#tombstoneOrder.push(meta.artifactId);
    }
    this.#tombstoneOrder.sort((a, b) => (this.#metas.get(a)?.createdAt ?? 0) - (this.#metas.get(b)?.createdAt ?? 0));
  }

  #loadOrWriteManifest(rootDir: string, sessionId: string): void {
    const manifestPath = join(rootDir, "session.json");
    try {
      const existing = JSON.parse(readFileSync(manifestPath, "utf8")) as SessionManifest;
      if (existing.sessionId !== sessionId) {
        throw new Error(
          `artifact store directory ${rootDir} belongs to session ${existing.sessionId}, not ${sessionId} — refusing to reuse it`,
        );
      }
      return;
    } catch (err) {
      if (err instanceof Error && err.message.includes("belongs to session")) throw err;
      // No manifest yet (ENOENT) or unparseable — write a fresh one.
    }
    const manifest: SessionManifest = { sessionId, root: rootDir, schemaVersion: ARTIFACT_SCHEMA_VERSION, createdAt: Date.now() };
    this.#writeFile("session.json", JSON.stringify(manifest));
  }

  put(record: ArtifactMeta, content: Record<string, string>): void {
    if (!ARTIFACT_ID_PATTERN.test(record.artifactId)) {
      throw new Error(`refusing to store artifact with malformed id: ${record.artifactId}`);
    }
    const meta: ArtifactMeta = { ...record, sessionId: this.#sessionId, schemaVersion: ARTIFACT_SCHEMA_VERSION, evicted: undefined };
    for (const [stream, text] of Object.entries(content)) {
      this.#writeFile(this.#contentName(meta.artifactId, stream), text);
    }
    this.#writeFile(`${meta.artifactId}.json`, JSON.stringify(meta));
    this.#metas.set(meta.artifactId, meta);
    this.#enforceLimits(meta.artifactId);
  }

  get(id: string): ArtifactEntry | null {
    // Validate the opaque id BEFORE deriving any filesystem path from it —
    // an id shaped like a traversal (e.g. "../../../etc/passwd") must never
    // reach join()/readFileSync.
    if (!ARTIFACT_ID_PATTERN.test(id)) return null;
    const meta = this.#metas.get(id);
    if (!meta) return null;
    if (meta.sessionId !== this.#sessionId) return null; // forged/foreign ownership — treated identically to unknown
    if (meta.evicted) return { meta, content: null };
    try {
      const content: Record<string, string> = {};
      for (const stream of Object.keys(meta.streams)) {
        content[stream] = readFileSync(join(this.#dir, this.#contentName(id, stream)), "utf8");
      }
      return { meta, content };
    } catch {
      // Content missing while meta survives (crash or external deletion):
      // report the same expired outcome as an explicit eviction.
      return { meta: { ...meta, evicted: true }, content: null };
    }
  }

  list(): ArtifactMeta[] {
    return [...this.#metas.values()]
      .filter((m) => m.sessionId === this.#sessionId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.artifactId < b.artifactId ? -1 : 1));
  }

  #contentName(id: string, stream: string): string {
    return `${id}.${stream}.txt`;
  }

  #writeFile(name: string, data: string): void {
    const tmp = join(this.#dir, `${name}.${process.pid}.tmp`);
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, join(this.#dir, name));
  }

  #enforceLimits(justPutId: string): void {
    for (;;) {
      const live = [...this.#metas.values()].filter((m) => !m.evicted);
      const totalBytes = live.reduce((sum, m) => sum + m.byteCount, 0);
      if (live.length <= this.#maxArtifacts && totalBytes <= this.#maxTotalBytes) break;
      const victim = live.find((m) => m.artifactId !== justPutId) ?? live[0];
      if (!victim) break;
      this.#evict(victim.artifactId);
    }
    this.#enforceTombstoneLimit();
  }

  #evict(id: string): void {
    const meta = this.#metas.get(id);
    if (!meta || meta.evicted) return;
    const evictedMeta: ArtifactMeta = { ...meta, evicted: true };
    this.#writeFile(`${id}.json`, JSON.stringify(evictedMeta));
    for (const stream of Object.keys(meta.streams)) {
      rmSync(join(this.#dir, this.#contentName(id, stream)), { force: true });
    }
    this.#metas.set(id, evictedMeta);
    this.#tombstoneOrder.push(id);
  }

  /** Beyond the retention horizon, the oldest tombstones are purged entirely — a request for that id then becomes "unknown", not "expired". */
  #enforceTombstoneLimit(): void {
    while (this.#tombstoneOrder.length > this.#maxTombstones) {
      const id = this.#tombstoneOrder.shift()!;
      this.#metas.delete(id);
      try {
        rmSync(join(this.#dir, `${id}.json`), { force: true });
      } catch {
        // best-effort cleanup only
      }
    }
  }
}
