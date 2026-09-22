import { createHash } from "node:crypto";

// Bumping this invalidates on-disk metadata written by an older shape — see
// LocalArtifactStore, which skips (never crashes on) a meta file whose
// schemaVersion does not match.
export const ARTIFACT_SCHEMA_VERSION = 1;

export interface StreamMeta {
  /** Total bytes the source actually produced for this stream, even if not all were retained. */
  bytesObserved: number;
  /** Bytes actually stored for this stream. */
  bytesRetained: number;
  /** True only when bytesRetained === bytesObserved for this stream; never inferred from retained length alone. */
  complete: boolean;
}

export interface ArtifactMeta {
  artifactId: string;
  /** Owning session — validated on every read/search/list so one session can never retrieve or evict another's artifacts (R7). */
  sessionId: string;
  schemaVersion: number;
  toolCallId: string;
  tool: string;
  commandOrTarget: string; // command for bash, path for read/write
  contentHash: string; // sha-256 of the canonical combined-for-hash representation (documented per caller)
  byteCount: number; // total retained bytes across all streams
  lineCount: number; // total retained lines across all streams (documented ordering: stream insertion order)
  captureComplete: boolean; // true iff every declared stream is complete
  createdAt: number;
  evicted?: boolean; // content deleted under store limits; meta retained
  /** Named streams this artifact was captured with — e.g. {stdout, stderr} for bash, {output} for everything else. */
  streams: Record<string, StreamMeta>;
}

export type ArtifactRecord = ArtifactMeta;

export interface ArtifactEntry {
  meta: ArtifactMeta;
  // null when the content was evicted; recovery surfaces this as an explicit expired outcome
  content: Record<string, string> | null;
}

export interface ArtifactStore {
  put(record: ArtifactMeta, content: Record<string, string>): void;
  get(id: string): ArtifactEntry | null;
  list(): ArtifactMeta[];
}

export class InvalidPatternError extends Error {
  readonly pattern: string;
  constructor(pattern: string, cause?: unknown) {
    super(`invalid regex pattern: ${pattern}`);
    this.name = "InvalidPatternError";
    this.pattern = pattern;
    this.cause = cause;
  }
}

// Only the final "\n" is a terminator, not a phantom empty line.
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function countLines(content: string): number {
  return splitLines(content).length;
}

export function sliceByLines(
  content: string,
  startLine: number,
  lineCount: number,
): { text: string; startLine: number; endLine: number; totalLines: number } {
  const lines = splitLines(content);
  const totalLines = lines.length;
  const start = Math.max(1, Math.floor(startLine) || 1);
  const count = Math.max(0, Math.floor(lineCount));
  if (count === 0 || start > totalLines) {
    return { text: "", startLine: start, endLine: start - 1, totalLines };
  }
  const end = Math.min(start + count - 1, totalLines);
  return { text: lines.slice(start - 1, end).join("\n"), startLine: start, endLine: end, totalLines };
}

// Regex work is capped by scanning at most this many characters, so a huge
// capture cannot turn search_output into a hang; matches are capped at `limit`.
const MAX_SCAN_CHARS = 1_000_000;

export function searchContent(
  content: string,
  pattern: string,
  limit = 50,
): { matches: { line: number; text: string }[]; totalMatches: number; truncated: boolean } {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (cause) {
    throw new InvalidPatternError(pattern, cause);
  }
  const clipped = content.length > MAX_SCAN_CHARS;
  const lines = splitLines(clipped ? content.slice(0, MAX_SCAN_CHARS) : content);
  const cap = Math.max(0, Math.floor(limit));
  const matches: { line: number; text: string }[] = [];
  let totalMatches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i]!)) continue;
    totalMatches += 1;
    if (matches.length < cap) matches.push({ line: i + 1, text: lines[i]! });
  }
  return { matches, totalMatches, truncated: totalMatches > matches.length || clipped };
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
