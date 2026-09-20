import { staticVerdict } from "./floor";
import { appendJournalEvent, type Journal } from "./journal";
import { policyForTrust, type Policy } from "./policy";
import { gateQuestions, sanitizeQuestions } from "./questions";
import type { Answer, AskResult, SystemOne } from "./types";

export type GateAction = "auto" | "ask" | "deny";

export interface GateDecision {
  action: GateAction;
  reasons: string[];
}

export interface GateInput {
  tool: string;
  command: string;
  task: string;
}

export type SanitizeAction = "pass" | "review" | "block";

export interface SanitizeDecision {
  action: SanitizeAction;
  reasons: string[];
}

const BAND_LABEL: Record<string, string> = { auto_run: "auto", ask_user: "ask", deny: "deny" };

export function decideGate(answers: Record<string, Answer>, policy: Policy): GateDecision {
  const reasons: string[] = [];
  const destructive = answers.destructive?.type === "score" ? answers.destructive.score : 0;
  const credentials = answers.touches_credentials?.type === "noul" ? answers.touches_credentials.noul : 0;
  const exfiltrates = answers.exfiltrates?.type === "noul" ? answers.exfiltrates.noul : 0;
  const onTask = answers.on_task?.type === "noul" ? answers.on_task.noul : 1;
  const disposition = answers.disposition?.type === "choice" ? answers.disposition : undefined;

  if (credentials >= policy.gate.credentialNoul) {
    return { action: "deny", reasons: [`secrets exposure probability ${credentials.toFixed(2)}`] };
  }
  if (exfiltrates >= policy.gate.exfilNoul) {
    return { action: "deny", reasons: [`exfiltration probability ${exfiltrates.toFixed(2)}`] };
  }
  if (destructive >= policy.gate.denyDestructive) {
    return { action: "deny", reasons: [`destructive score ${destructive.toFixed(2)} >= deny line ${policy.gate.denyDestructive}`] };
  }

  if (!disposition) {
    return { action: "ask", reasons: ["no disposition answer"] };
  }

  if (disposition.choice === "deny") {
    if (disposition.confidence >= policy.confidenceFloor) {
      return { action: "deny", reasons: [`disposition deny at confidence ${disposition.confidence.toFixed(2)}`] };
    }
    return { action: "ask", reasons: [`disposition deny but low confidence (${disposition.confidence.toFixed(2)})`] };
  }

  if (disposition.choice === "ask_user") {
    return { action: "ask", reasons: [`disposition ask_user at confidence ${disposition.confidence.toFixed(2)}`] };
  }

  if (disposition.confidence < policy.confidenceFloor) {
    return { action: "ask", reasons: [`disposition auto_run but confidence ${disposition.confidence.toFixed(2)} below uncertainty floor`] };
  }
  if (disposition.confidence < policy.gate.autoConfidence) {
    return {
      action: "ask",
      reasons: [`confidence ${disposition.confidence.toFixed(2)} < auto bar ${policy.gate.autoConfidence.toFixed(2)} (trust dial)`],
    };
  }
  if (destructive >= policy.gate.askDestructive) {
    reasons.push(`destructive score ${destructive.toFixed(2)} >= ask line ${policy.gate.askDestructive}`);
    return { action: "ask", reasons };
  }
  if (onTask <= policy.gate.offTaskOnTask) {
    return { action: "ask", reasons: [`command not on-task (on_task ${onTask.toFixed(2)})`] };
  }

  reasons.push(`disposition auto_run at confidence ${disposition.confidence.toFixed(2)}`);
  return { action: "auto", reasons };
}

export function decideSanitize(answers: Record<string, Answer>, policy: Policy): SanitizeDecision {
  const reasons: string[] = [];
  const nouls: [string, number][] = [];
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "noul") nouls.push([id, answer.noul]);
  }
  const severity = answers.severity?.type === "score" ? answers.severity.score : 0;

  for (const [id, noul] of nouls) {
    if (noul >= policy.sanitize.action) reasons.push(`${id}=${noul.toFixed(2)} >= action ${policy.sanitize.action}`);
  }
  if (severity >= policy.sanitize.severityBlock) {
    reasons.push(`severity ${severity.toFixed(2)} >= block line ${policy.sanitize.severityBlock}`);
  }
  if (reasons.length > 0) return { action: "block", reasons };

  for (const [id, noul] of nouls) {
    if (noul >= policy.sanitize.review) reasons.push(`${id}=${noul.toFixed(2)} >= review ${policy.sanitize.review}`);
  }
  if (reasons.length > 0) return { action: "review", reasons };

  return { action: "pass", reasons };
}

export interface ReflexEngineDeps {
  systemOne: SystemOne;
  journal: Journal;
  policy?: Policy;
  environment?: string;
}

export class ReflexEngine {
  private readonly systemOne: SystemOne;
  private readonly journal: Journal;
  readonly policy: Policy;
  private readonly environment: string;

  constructor(deps: ReflexEngineDeps) {
    this.systemOne = deps.systemOne;
    this.journal = deps.journal;
    this.policy = deps.policy ?? policyForTrust(0.3);
    this.environment = deps.environment ?? "A git repository in the current working directory.";
  }

  async gate(input: GateInput): Promise<GateDecision & { result?: AskResult }> {
    const floor = staticVerdict(input.tool, { command: input.command });

    if (floor === "deny") {
      const decision: GateDecision = { action: "deny", reasons: ["static floor: dangerous pattern"] };
      this.recordDecision("gate", decision, input.command);
      return decision;
    }

    const state = {
      task: input.task,
      environment: this.environment,
      action: { tool: input.tool, command: input.command },
    };
    const questions = gateQuestions(input.command, input.task);
    const result = await this.systemOne.ask(state, questions);
    this.recordReflex("gate", input.command, state, questions, result);

    let decision = decideGate(result.answers, this.policy);
    if (floor === "ask" && decision.action === "auto") {
      decision = { action: "ask", reasons: ["static floor: risky pattern", ...decision.reasons] };
    }
    this.recordDecision("gate", decision, input.command);
    return { ...decision, result };
  }

  async sanitize(content: string, source: string): Promise<SanitizeDecision & { result: AskResult }> {
    const state = {
      situation:
        "A coding agent is working in a repository and just read this content as the output of a tool (a file, command output, or web page).",
      content,
    };
    const result = await this.systemOne.ask(state, sanitizeQuestions());
    this.recordReflex("sanitize", source, state, sanitizeQuestions(), result);

    const decision = decideSanitize(result.answers, this.policy);
    this.recordDecision("sanitize", decision, source);
    return { ...decision, result };
  }

  private recordReflex(
    reflex: string,
    subject: string,
    state: unknown,
    questions: Record<string, import("./types").Question>,
    result: AskResult,
  ): void {
    this.journal.append({
      t: "reflex",
      ts: Date.now(),
      reflex,
      subject,
      state,
      questions,
      result,
    });
  }

  private recordDecision(reflex: string, decision: { action: string; reasons: string[] }, subject: string): void {
    this.journal.append({
      t: "decision",
      ts: Date.now(),
      reflex,
      action: decision.action,
      reasons: decision.reasons,
    });
  }
}
