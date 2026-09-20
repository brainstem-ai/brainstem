import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AskResult, Question } from "./types";

export type JournalEvent =
  | { t: "session_start"; ts: number; trust: number }
  | { t: "session_end"; ts: number }
  | { t: "user_message"; ts: number; text: string }
  | { t: "assistant_message"; ts: number; text: string; model: string; costUsd: number }
  | { t: "reflex"; ts: number; reflex: string; subject: string; state: unknown; questions: Record<string, Question>; result: AskResult }
  | { t: "decision"; ts: number; reflex: string; action: string; reasons: string[] }
  | { t: "tool_call"; ts: number; tool: string; args: unknown }
  | { t: "tool_result"; ts: number; tool: string; ok: boolean; summary: string };

export interface Journal {
  append(event: JournalEvent): void;
}

export function openJournal(path: string): Journal {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append(event: JournalEvent) {
      appendJournalEvent(path, event);
    },
  };
}

export function appendJournalEvent(path: string, event: JournalEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
}

export function loadJournal(path: string): JournalEvent[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEvent);
}
