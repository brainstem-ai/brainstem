import { createHash, randomUUID } from "node:crypto";

export interface TaskState {
  id: string;
  revision: number;
  objective: string;
  updates: string[];
}

export type ToolStatus = "ok" | "error" | "timeout" | "cancelled" | "blocked";

export interface ToolObservation {
  toolCallId: string;
  tool: string;
  argsSummary: unknown;
  status: ToolStatus;
  exitCode?: number;
  durationMs: number;
  excerpt: string;
  truncated: boolean;
}

export function canonicalJson(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return `[${input.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  switch (typeof input) {
    case "string":
      return JSON.stringify(input);
    case "number":
      return Number.isFinite(input) ? JSON.stringify(input) : "null";
    case "boolean":
      return input ? "true" : "false";
    case "object": {
      const record = input as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
    }
    default:
      return "null";
  }
}

export function hashAction(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
