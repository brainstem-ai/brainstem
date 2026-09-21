import { readFileSync } from "node:fs";
import { resolveParentForWrite } from "./paths";

const DIFF_CAP = 1_500;
const NEW_FILE_LINES = 40;
// Line-level LCS is quadratic; past this size we report byte counts instead of a
// diff rather than spending the gate's latency budget on a table the size of a file.
const DIFF_LINE_LIMIT = 1_000;

export interface ChangeSummary {
  changeSummary: string;
  evidenceIncomplete: boolean;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

/** Longest common subsequence over lines, returned as a unified-style diff body. */
function unifiedDiff(before: string[], after: string[]): string {
  const n = before.length;
  const m = after.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push(` ${before[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`-${before[i]}`);
      i += 1;
    } else {
      out.push(`+${after[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    out.push(`-${before[i]}`);
    i += 1;
  }
  while (j < m) {
    out.push(`+${after[j]}`);
    j += 1;
  }
  return out.join("\n");
}

function capped(body: string, header: string): ChangeSummary {
  if (body.length <= DIFF_CAP) return { changeSummary: `${header}\n${body}`, evidenceIncomplete: false };
  return {
    changeSummary: `${header}\n${body.slice(0, DIFF_CAP)}\n... (change summary truncated at ${DIFF_CAP} chars)`,
    evidenceIncomplete: true,
  };
}

/**
 * Bounded semantic evidence about what a write would change, for the gate.
 *
 * This is deliberately separate from the immutable action hash used for approval:
 * the hash binds the exact validated arguments, this describes them well enough
 * for a judgment without shipping whole file bodies into the prompt.
 */
export function changeSummaryForWrite(root: string, target: string, content: string): ChangeSummary {
  const resolved = resolveParentForWrite(root, target);

  let existing: string | undefined;
  try {
    existing = readFileSync(resolved, "utf8");
  } catch {
    existing = undefined;
  }

  const bytes = Buffer.byteLength(content, "utf8");

  if (existing === undefined) {
    const lines = splitLines(content);
    const head = lines.slice(0, NEW_FILE_LINES);
    const elided = lines.length > NEW_FILE_LINES;
    const header = `new file ${target} (${bytes} bytes, ${lines.length} lines)${elided ? `, first ${NEW_FILE_LINES} lines:` : ":"}`;
    const summary = capped(head.join("\n"), header);
    return { changeSummary: summary.changeSummary, evidenceIncomplete: summary.evidenceIncomplete || elided };
  }

  if (existing === content) {
    return { changeSummary: `overwrite ${target} with identical content (${bytes} bytes)`, evidenceIncomplete: false };
  }

  const before = splitLines(existing);
  const after = splitLines(content);
  if (before.length > DIFF_LINE_LIMIT || after.length > DIFF_LINE_LIMIT) {
    return {
      changeSummary: `overwrite ${target}: ${before.length} lines (${Buffer.byteLength(existing, "utf8")} bytes) replaced by ${after.length} lines (${bytes} bytes); too large to diff`,
      evidenceIncomplete: true,
    };
  }

  return capped(unifiedDiff(before, after), `overwrite existing ${target} (${before.length} -> ${after.length} lines):`);
}
