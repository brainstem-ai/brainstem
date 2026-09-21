import { hashAction } from "./evidence";
import type { Answer, AskResult, Question } from "./types";

export interface AnswerCacheEntry {
  answers: Record<string, Answer>;
  // The ORIGINAL call's result — model, latency, usage — kept unchanged for
  // provenance. A hit's journal event separately records that it was a hit;
  // this is "what the original call actually cost," not "what this use cost."
  result: AskResult;
  originalJudgmentId: string;
  cachedAt: number;
}

export interface AnswerCache {
  get(key: string): AnswerCacheEntry | undefined;
  set(key: string, value: AnswerCacheEntry): void;
}

export function computeCacheKey(provider: string, state: unknown, questions: Record<string, Question>): string {
  return hashAction({ provider, state, questions });
}

export interface BoundedAnswerCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 2_000_000;

function estimateBytes(entry: AnswerCacheEntry): number {
  return JSON.stringify(entry).length;
}

// LRU by insertion order: `get` deletes-and-reinserts a hit to refresh its
// recency, and eviction always removes the Map's first (oldest) key.
export class BoundedAnswerCache implements AnswerCache {
  #entries = new Map<string, AnswerCacheEntry>();
  #sizes = new Map<string, number>();
  #totalBytes = 0;
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(options: BoundedAnswerCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get(key: string): AnswerCacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  set(key: string, value: AnswerCacheEntry): void {
    this.#deleteIfPresent(key);
    const size = estimateBytes(value);
    this.#entries.set(key, value);
    this.#sizes.set(key, size);
    this.#totalBytes += size;
    this.#evictOverflow();
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#totalBytes;
  }

  #deleteIfPresent(key: string): void {
    if (!this.#entries.has(key)) return;
    this.#totalBytes -= this.#sizes.get(key) ?? 0;
    this.#entries.delete(key);
    this.#sizes.delete(key);
  }

  #evictOverflow(): void {
    while (this.#entries.size > 0 && (this.#entries.size > this.#maxEntries || this.#totalBytes > this.#maxBytes)) {
      const oldestKey = this.#entries.keys().next().value as string;
      this.#deleteIfPresent(oldestKey);
    }
  }
}
