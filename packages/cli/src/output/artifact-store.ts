import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactEntry, ArtifactMeta, ArtifactStore } from "@brainstem/core";

export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_ARTIFACTS = 200;

export interface LocalArtifactStoreOptions {
  maxTotalBytes?: number;
  maxArtifacts?: number;
}

// File-per-artifact store rooted at <sessionDir>/artifacts/. Every write goes
// through a temp file + rename so a crash mid-put can never leave a torn
// capture: readers see either the previous state or the complete new file.
export class LocalArtifactStore implements ArtifactStore {
  readonly #dir: string;
  readonly #maxTotalBytes: number;
  readonly #maxArtifacts: number;
  readonly #metas = new Map<string, ArtifactMeta>();

  constructor(rootDir: string, options: LocalArtifactStoreOptions = {}) {
    this.#dir = rootDir;
    this.#maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
    this.#maxArtifacts = options.maxArtifacts ?? MAX_ARTIFACTS;
    mkdirSync(rootDir, { recursive: true });
    for (const name of readdirSync(rootDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(rootDir, name), "utf8")) as ArtifactMeta;
        if (typeof meta.artifactId === "string") this.#metas.set(meta.artifactId, meta);
      } catch {
        // A metadata file only exists after its rename completed; an unparseable
        // file is crash debris without a matching content file — skip it.
      }
    }
  }

  put(record: ArtifactMeta, content: string): void {
    const meta: ArtifactMeta = { ...record, evicted: undefined };
    this.#writeFile(`${meta.artifactId}.txt`, content);
    this.#writeFile(`${meta.artifactId}.json`, JSON.stringify(meta));
    this.#metas.set(meta.artifactId, meta);
    this.#enforceLimits(meta.artifactId);
  }

  get(id: string): ArtifactEntry | null {
    const meta = this.#metas.get(id);
    if (!meta) return null;
    if (meta.evicted) return { meta, content: null };
    try {
      return { meta, content: readFileSync(this.#contentPath(id), "utf8") };
    } catch {
      // Content missing while meta survives (crash or external deletion):
      // report the same expired outcome as an explicit eviction.
      return { meta: { ...meta, evicted: true }, content: null };
    }
  }

  list(): ArtifactMeta[] {
    return [...this.#metas.values()].sort(
      (a, b) => a.createdAt - b.createdAt || (a.artifactId < b.artifactId ? -1 : 1),
    );
  }

  #contentPath(id: string): string {
    return join(this.#dir, `${id}.txt`);
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
      if (live.length <= this.#maxArtifacts && totalBytes <= this.#maxTotalBytes) return;
      const victim = live.find((m) => m.artifactId !== justPutId) ?? live[0];
      if (!victim) return;
      this.#evict(victim.artifactId);
    }
  }

  #evict(id: string): void {
    const meta = this.#metas.get(id);
    if (!meta || meta.evicted) return;
    const evictedMeta: ArtifactMeta = { ...meta, evicted: true };
    this.#writeFile(`${id}.json`, JSON.stringify(evictedMeta));
    rmSync(this.#contentPath(id), { force: true });
    this.#metas.set(id, evictedMeta);
  }
}
