import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { InvalidPatternError, REVIEW_CHAR_CAP, searchContent, sliceByLines, splitLines, type ArtifactStore } from "@brainstem/core";

export interface RecoveryToolDeps {
  store: ArtifactStore;
}

const READ_DEFAULT_LINES = 200;
const READ_MAX_LINES = 2_000;
const SEARCH_DEFAULT_LIMIT = 50;
// Reserve room for the header/continuation notice so a page's body plus its
// own receipt never exceeds the same review boundary the harness applies to
// everything else (packages/core/src/presentation.ts) — the receipt is
// computed from what's ACTUALLY delivered, never a second independent claim.
const RECEIPT_RESERVE_CHARS = 400;
const PAGE_BODY_CHAR_CAP = REVIEW_CHAR_CAP - RECEIPT_RESERVE_CHARS;

function clampInt(value: number | undefined, fallback: number, max: number, min = 1): number {
  const n = Math.floor(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function defaultStream(content: Record<string, string>, requested?: string): string | undefined {
  if (requested !== undefined) return requested in content ? requested : undefined;
  if ("stdout" in content) return "stdout";
  if ("output" in content) return "output";
  return Object.keys(content)[0];
}

function streamsList(content: Record<string, string>): string {
  const keys = Object.keys(content);
  return keys.length > 0 ? keys.join(", ") : "(none)";
}

/** Returns the largest whole-line prefix of `lines` that fits within `capChars` (joined with "\n"), never a partial line. */
function fitWholeLines(lines: string[], capChars: number): { text: string; count: number } {
  let count = 0;
  let total = 0;
  for (const line of lines) {
    const size = line.length + (count > 0 ? 1 : 0);
    if (count === 0 && line.length > capChars) break; // even one line alone doesn't fit — caller falls back to byte pagination
    if (count > 0 && total + size > capChars) break;
    total += size;
    count += 1;
  }
  return { text: lines.slice(0, count).join("\n"), count };
}

/** Byte-safe slice of a single (possibly huge) line, never splitting a UTF-8 sequence at either edge. */
function sliceLineByBytes(line: string, startByte: number, maxBytes: number): { text: string; startByte: number; endByte: number; totalBytes: number } {
  const buf = Buffer.from(line, "utf8");
  const totalBytes = buf.length;
  const start = Math.max(0, Math.min(startByte, totalBytes));
  let end = Math.min(start + maxBytes, totalBytes);
  // Back up over any continuation bytes, then (if the resulting lead byte's
  // declared sequence length would run past `end`) over the lead byte too,
  // so the slice never ends mid-codepoint.
  while (end > start && (buf[end - 1]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  if (end > start && end < totalBytes) {
    const lead = buf[end - 1]!;
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (seqLen > 1 && end - (end - 1) < seqLen) end -= 1;
  }
  return { text: buf.subarray(start, end).toString("utf8"), startByte: start, endByte: end, totalBytes };
}

// Every failure mode gets its own explicit wording: the model must be able to
// tell a wrong id apart from an evicted capture apart from an empty capture.
function unknownMessage(id: string): string {
  return `unknown artifact ${id}: no capture with this id exists in this session`;
}

function expiredMessage(id: string): string {
  return `artifact ${id} expired: the capture was evicted from the artifact store and can no longer be recovered without rerunning the command`;
}

function emptyMessage(id: string, stream: string): string {
  return `artifact ${id} stream ${stream} is empty: this stream contains no output`;
}

function entryOutcome(captureComplete: boolean): "complete" | "truncated-capture" {
  return captureComplete ? "complete" : "truncated-capture";
}

export function makeRecoveryTools(deps: RecoveryToolDeps): AgentTool[] {
  const readParams = Type.Object({
    id: Type.String({ description: "Artifact id from a capture notice" }),
    stream: Type.Optional(Type.String({ description: "Which captured stream to read (e.g. \"stdout\", \"stderr\", or \"output\"); defaults to stdout/output" })),
    startLine: Type.Optional(Type.Number({ description: "First line to return (1-indexed, default 1)" })),
    lineCount: Type.Optional(Type.Number({ description: `Number of lines to return (default ${READ_DEFAULT_LINES}, max ${READ_MAX_LINES})` })),
    startByteInLine: Type.Optional(
      Type.Number({ description: "Resume a single line that was too long to fit in one page, at this byte offset within that line (from a previous page's continuation notice)." }),
    ),
  });
  const readOutput: AgentTool<typeof readParams> = {
    name: "read_output",
    label: "Read Captured Output",
    description:
      "Recover lines from a previously captured tool output artifact by id. Use this instead of rerunning a command when the presented output was bounded.",
    parameters: readParams,
    executionMode: "parallel",
    execute: async (_id, params) => {
      const entry = deps.store.get(params.id);
      if (!entry) {
        return { content: [{ type: "text", text: unknownMessage(params.id) }], details: { outcome: "unknown" } };
      }
      if (entry.content === null) {
        return { content: [{ type: "text", text: expiredMessage(params.id) }], details: { outcome: "expired" } };
      }
      const stream = defaultStream(entry.content, params.stream);
      if (stream === undefined) {
        return {
          content: [{ type: "text", text: `unknown stream "${params.stream}" for artifact ${params.id}: available streams are ${streamsList(entry.content)}` }],
          details: { outcome: "unknown-stream" },
        };
      }
      const content = entry.content[stream]!;
      if (content.length === 0) {
        return { content: [{ type: "text", text: emptyMessage(params.id, stream) }], details: { outcome: "empty" } };
      }

      const start = clampInt(params.startLine, 1, Number.MAX_SAFE_INTEGER);
      const requestedCount = params.startByteInLine !== undefined ? 1 : clampInt(params.lineCount, READ_DEFAULT_LINES, READ_MAX_LINES);
      const slice = sliceByLines(content, start, requestedCount);
      const complete = entry.meta.streams[stream]?.complete ?? entry.meta.captureComplete;

      if (slice.text.length === 0) {
        const header = `artifact ${params.id} stream ${stream} lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines} (${entryOutcome(complete)})`;
        return {
          content: [{ type: "text", text: `${header}\n(requested range is past the end of the capture)` }],
          details: { outcome: "ok", startLine: slice.startLine, endLine: slice.endLine },
        };
      }

      const lines = splitLines(slice.text);

      if (params.startByteInLine !== undefined || (lines.length === 1 && lines[0]!.length > PAGE_BODY_CHAR_CAP)) {
        // Either explicitly continuing a prior oversized-line page, or the
        // single requested line itself doesn't fit in one page — paginate
        // that one line by UTF-8 byte range instead of silently clipping it.
        const lineText = lines[0] ?? "";
        const byteSlice = sliceLineByBytes(lineText, params.startByteInLine ?? 0, PAGE_BODY_CHAR_CAP);
        const header = `artifact ${params.id} stream ${stream} line ${slice.startLine} bytes ${byteSlice.startByte}-${byteSlice.endByte} of ${byteSlice.totalBytes} (${entryOutcome(complete)}, partial line)`;
        const cont =
          byteSlice.endByte < byteSlice.totalBytes
            ? `\n[brainstem] line continues — call read_output again with startLine=${slice.startLine}, startByteInLine=${byteSlice.endByte}${stream !== defaultStream(entry.content) ? `, stream="${stream}"` : ""} to continue.`
            : "";
        return {
          content: [{ type: "text", text: `${header}\n${byteSlice.text}${cont}` }],
          details: { outcome: "ok", startLine: slice.startLine, endLine: slice.startLine, partialLine: true },
        };
      }

      const fit = fitWholeLines(lines, PAGE_BODY_CHAR_CAP);
      const deliveredEndLine = slice.startLine + fit.count - 1;
      const pageBounded = fit.count < lines.length;
      const header = `artifact ${params.id} stream ${stream} lines ${slice.startLine}-${deliveredEndLine} of ${slice.totalLines} (${entryOutcome(complete)}${pageBounded ? ", page bounded — more requested lines remain" : ""})`;
      const cont = pageBounded ? `\n[brainstem] continue with startLine=${deliveredEndLine + 1} to recover the rest of this range.` : "";
      return {
        content: [{ type: "text", text: `${header}\n${fit.text}${cont}` }],
        details: { outcome: "ok", startLine: slice.startLine, endLine: deliveredEndLine },
      };
    },
  };

  const searchParams = Type.Object({
    id: Type.String({ description: "Artifact id from a capture notice" }),
    stream: Type.Optional(Type.String({ description: "Which captured stream to search (e.g. \"stdout\", \"stderr\", or \"output\"); defaults to stdout/output" })),
    pattern: Type.String({ description: "Regular expression to search for" }),
    limit: Type.Optional(Type.Number({ description: `Maximum matches to return (default ${SEARCH_DEFAULT_LIMIT})` })),
    startLine: Type.Optional(Type.Number({ description: "Resume scanning from this line (1-indexed, default 1) — use the totalScanned receipt from a truncated search to continue coverage without gaps or re-scanning." })),
  });
  const searchOutput: AgentTool<typeof searchParams> = {
    name: "search_output",
    label: "Search Captured Output",
    description:
      "Search a previously captured tool output artifact by id for a regular expression, with exact line numbers. Use this to locate content in captures whose presented view was bounded.",
    parameters: searchParams,
    executionMode: "parallel",
    execute: async (_id, params) => {
      const entry = deps.store.get(params.id);
      if (!entry) {
        return { content: [{ type: "text", text: unknownMessage(params.id) }], details: { outcome: "unknown" } };
      }
      if (entry.content === null) {
        return { content: [{ type: "text", text: expiredMessage(params.id) }], details: { outcome: "expired" } };
      }
      const stream = defaultStream(entry.content, params.stream);
      if (stream === undefined) {
        return {
          content: [{ type: "text", text: `unknown stream "${params.stream}" for artifact ${params.id}: available streams are ${streamsList(entry.content)}` }],
          details: { outcome: "unknown-stream" },
        };
      }
      const content = entry.content[stream]!;
      if (content.length === 0) {
        return { content: [{ type: "text", text: emptyMessage(params.id, stream) }], details: { outcome: "empty" } };
      }

      const allLines = splitLines(content);
      const startLine = clampInt(params.startLine, 1, Math.max(1, allLines.length));
      const scanFrom = allLines.slice(startLine - 1).join("\n");

      let result;
      try {
        result = searchContent(scanFrom, params.pattern, clampInt(params.limit, SEARCH_DEFAULT_LIMIT, Number.MAX_SAFE_INTEGER));
      } catch (error) {
        if (error instanceof InvalidPatternError) {
          return {
            content: [
              {
                type: "text",
                text: `invalid pattern for search_output: ${params.pattern} (${error.message}). Fix the regular expression and retry.`,
              },
            ],
            details: { outcome: "invalid-pattern" },
          };
        }
        throw error;
      }
      // Line numbers from searchContent are relative to `scanFrom`; rebase to the full capture.
      const rebasedMatches = result.matches.map((m) => ({ line: m.line + startLine - 1, text: m.text }));
      const scannedTo = startLine - 1 + splitLines(scanFrom).length;
      const header = `artifact ${params.id} stream ${stream} search "${params.pattern}" from line ${startLine}: ${result.totalMatches} match(es) in lines ${startLine}-${scannedTo} of ${allLines.length}${result.truncated ? ` (showing first ${rebasedMatches.length})` : ""}`;
      const continuationNotice =
        result.truncated && scannedTo < allLines.length
          ? `\n[brainstem] scan bounded — continue with startLine=${scannedTo + 1} to cover the rest.`
          : "";
      const text =
        rebasedMatches.length === 0
          ? `${header}\nno matches${continuationNotice}`
          : `${header}\n${rebasedMatches.map((m) => `${m.line}: ${m.text}`).join("\n")}${continuationNotice}`;
      return {
        content: [{ type: "text", text }],
        details: { outcome: "ok", totalMatches: result.totalMatches, truncated: result.truncated, scannedTo },
      };
    },
  };

  return [readOutput, searchOutput];
}
