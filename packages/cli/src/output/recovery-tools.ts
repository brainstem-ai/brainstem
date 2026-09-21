import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { InvalidPatternError, searchContent, sliceByLines, type ArtifactStore } from "@brainstem/core";

export interface RecoveryToolDeps {
  store: ArtifactStore;
}

const READ_DEFAULT_LINES = 200;
const READ_MAX_LINES = 2_000;
const SEARCH_DEFAULT_LIMIT = 50;

function clampInt(value: number | undefined, fallback: number, max: number, min = 1): number {
  const n = Math.floor(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Every failure mode gets its own explicit wording: the model must be able to
// tell a wrong id apart from an evicted capture apart from an empty capture.
function unknownMessage(id: string): string {
  return `unknown artifact ${id}: no capture with this id exists in this session`;
}

function expiredMessage(id: string): string {
  return `artifact ${id} expired: the capture was evicted from the artifact store and can no longer be recovered without rerunning the command`;
}

function emptyMessage(id: string): string {
  return `artifact ${id} is empty: the capture contains no output`;
}

function entryOutcome(entry: { meta: { captureComplete: boolean } } | null): "complete" | "truncated-capture" {
  return entry!.meta.captureComplete ? "complete" : "truncated-capture";
}

export function makeRecoveryTools(deps: RecoveryToolDeps): AgentTool[] {
  const readParams = Type.Object({
    id: Type.String({ description: "Artifact id from a capture notice" }),
    startLine: Type.Optional(Type.Number({ description: "First line to return (1-indexed, default 1)" })),
    lineCount: Type.Optional(Type.Number({ description: `Number of lines to return (default ${READ_DEFAULT_LINES}, max ${READ_MAX_LINES})` })),
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
      if (entry.content.length === 0) {
        return { content: [{ type: "text", text: emptyMessage(params.id) }], details: { outcome: "empty" } };
      }
      const start = clampInt(params.startLine, 1, Number.MAX_SAFE_INTEGER);
      const count = clampInt(params.lineCount, READ_DEFAULT_LINES, READ_MAX_LINES);
      const slice = sliceByLines(entry.content, start, count);
      const header = `artifact ${params.id} lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines} (${entryOutcome(entry)})`;
      const text =
        slice.text.length === 0
          ? `${header}\n(requested range is past the end of the capture)`
          : `${header}\n${slice.text}`;
      return { content: [{ type: "text", text }], details: { outcome: "ok", startLine: slice.startLine, endLine: slice.endLine } };
    },
  };

  const searchParams = Type.Object({
    id: Type.String({ description: "Artifact id from a capture notice" }),
    pattern: Type.String({ description: "Regular expression to search for" }),
    limit: Type.Optional(Type.Number({ description: `Maximum matches to return (default ${SEARCH_DEFAULT_LIMIT})` })),
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
      if (entry.content.length === 0) {
        return { content: [{ type: "text", text: emptyMessage(params.id) }], details: { outcome: "empty" } };
      }
      let result;
      try {
        result = searchContent(entry.content, params.pattern, clampInt(params.limit, SEARCH_DEFAULT_LIMIT, Number.MAX_SAFE_INTEGER));
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
      const header = `artifact ${params.id} search "${params.pattern}": ${result.totalMatches} match(es)${result.truncated ? ` (showing first ${result.matches.length})` : ""}`;
      const text =
        result.matches.length === 0
          ? `${header}\nno matches`
          : `${header}\n${result.matches.map((m) => `${m.line}: ${m.text}`).join("\n")}`;
      return {
        content: [{ type: "text", text }],
        details: { outcome: "ok", totalMatches: result.totalMatches, truncated: result.truncated },
      };
    },
  };

  return [readOutput, searchOutput];
}
