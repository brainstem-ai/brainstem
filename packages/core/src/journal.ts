import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StaticVerdict } from "./floor";
import type { Policy } from "./policy";
import type { ToolObservation } from "./evidence";
import type { AskResult, Question } from "./types";

export const JOURNAL_SCHEMA_VERSION = 2;

export interface TurnSpans {
  jevMs?: number;
  approvalWaitMs?: number;
  toolMs?: number;
  modelMs?: number;
}

export type ReflexStatus = "completed" | "unavailable" | "cancelled";

export type ApprovalStatus = "requested" | "approved" | "denied" | "cancelled" | "invalidated";

export type JournalEvent =
  | {
      t: "session_start";
      v: 2;
      sessionId: string;
      ts: number;
      trust: number;
      policySnapshot: Policy;
      policyHash: string;
    }
  | { t: "session_end"; v: 2; sessionId: string; ts: number; reason: "normal" | "error"; error?: string }
  | { t: "task_start"; v: 2; sessionId: string; taskId: string; ts: number; objective: string }
  | { t: "task_update"; v: 2; taskId: string; revision: number; ts: number; text: string }
  | { t: "turn_start"; v: 2; sessionId: string; taskId: string; turnId: string; ts: number }
  | {
      t: "turn_end";
      v: 2;
      turnId: string;
      ts: number;
      modelCalls: number;
      durationMs: number;
      spans?: TurnSpans;
    }
  | {
      t: "reflex";
      v: 2;
      sessionId: string;
      taskId?: string;
      turnId?: string;
      judgmentId: string;
      ts: number;
      reflex: string;
      subject: string;
      status: ReflexStatus;
      state: unknown;
      questions: Record<string, Question>;
      result: AskResult | null;
      reason?: string;
    }
  | {
      t: "decision";
      v: 2;
      judgmentId?: string;
      ts: number;
      reflex: string;
      action: string;
      reasons: string[];
      staticVerdict?: StaticVerdict;
      approvalId?: string;
    }
  | {
      t: "approval";
      v: 2;
      approvalId: string;
      ts: number;
      status: ApprovalStatus;
      taskId: string;
      toolCallId: string;
      actionHash: string;
      reasons: string[];
    }
  | {
      t: "tool_observation";
      v: 2;
      toolCallId: string;
      turnId: string;
      ts: number;
      observation: ToolObservation;
      deliveredExcerpt: string;
      deliveredTruncated: boolean;
      deliveredWhy?: string;
    }
  | {
      t: "llm_call";
      v: 2;
      turnId: string;
      ts: number;
      model: string;
      durationMs: number;
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costTotal: number | "unknown" };
      firstTokenMs?: number;
    }
  | {
      t: "artifacts";
      v: 2;
      artifactId: string;
      ts: number;
      toolCallId: string;
      contentHash: string;
      captureComplete: boolean;
      byteCount: number;
      presentedViewHash?: string;
      sectionManifestHash?: string;
    };

export interface Journal {
  append(event: JournalEvent): void;
}

export function openJournal(path: string): Journal {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append(event: JournalEvent) {
      appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
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
    .map((line, index) => {
      const event = JSON.parse(line) as { v?: number };
      if (event.v !== JOURNAL_SCHEMA_VERSION) {
        throw new Error(
          `unknown journal schema version ${String(event.v)} at ${path}:${index + 1} (expected v${JOURNAL_SCHEMA_VERSION})`,
        );
      }
      return event as JournalEvent;
    });
}
