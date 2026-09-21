import { checkBudgets, type BudgetCheck, type BudgetLimits } from "./budgets";
import { newId } from "./evidence";
import { JevCancelledError, JevUnavailableError } from "./errors";
import { staticVerdict, type StaticVerdict } from "./floor";
import type { Journal, ReflexStatus } from "./journal";
import { policyForTrust, type Policy } from "./policy";
import {
  gateQuestions,
  pulseQuestions,
  sanitizeQuestions,
  sanitizeVerifyGroups,
  steerQuestions,
  verifyQuestions,
} from "./questions";
import type { Answer, AskOptions, AskResult, JudgmentOutcome, Question, SystemOne } from "./types";
import { validateAnswers, validateGroups } from "./validation";

export type GateAction = "auto" | "ask" | "deny";

export interface GateDecision {
  action: GateAction;
  reasons: string[];
}

export interface GateInput {
  tool: string;
  command: string;
  task: string;
  path?: string;
}

export type SanitizeAction = "pass" | "review" | "block";

export interface SanitizeDecision {
  action: SanitizeAction;
  reasons: string[];
}

export type VerifyAction = "ok" | "mismatch";

export interface VerifyDecision {
  action: VerifyAction;
  reasons: string[];
  // true only when a completed judgment backed the decision; a fallback is NOT a positive verification
  verified: boolean;
}

export type PulseAction = "continue" | "intervene" | "stop";

export interface PulseDecision {
  action: PulseAction;
  reasons: string[];
}

export interface SteerDecision {
  tier: "frontier" | "mini";
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

const SANITIZE_HAZARDS = ["contains_agent_directive", "tries_to_override", "requests_dangerous_action"] as const;

export function decideSanitize(answers: Record<string, Answer>, policy: Policy): SanitizeDecision {
  const reasons: string[] = [];
  const nouls: [string, number][] = [];
  for (const id of SANITIZE_HAZARDS) {
    const answer = answers[id];
    if (answer?.type === "noul") nouls.push([id, answer.noul]);
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

export function decideVerify(answers: Record<string, Answer>, policy: Policy): VerifyDecision {
  const reasons: string[] = [];
  const satisfied = answers.satisfies_intent?.type === "noul" ? answers.satisfies_intent.noul : 1;
  const quality = answers.result_quality?.type === "score" ? answers.result_quality.score : 2;

  if (satisfied < policy.confidenceFloor && quality <= 0.5) {
    return {
      action: "mismatch",
      reasons: [`satisfies_intent=${satisfied.toFixed(2)} below floor ${policy.confidenceFloor}, quality ${quality.toFixed(1)}`],
      verified: true,
    };
  }
  return { action: "ok", reasons, verified: true };
}

export function decidePulse(answers: Record<string, Answer>, policy: Policy): PulseDecision {
  const reasons: string[] = [];
  const repeating = answers.repeating?.type === "noul" ? answers.repeating.noul : 0;
  const progressing = answers.progressing?.type === "noul" ? answers.progressing.noul : 1;
  const stuck = answers.stuck_on_same_error?.type === "noul" ? answers.stuck_on_same_error.noul : 0;
  const worth = answers.worth_continuing?.type === "score" ? answers.worth_continuing.score : 2;

  if (worth <= policy.pulse.stopScore) {
    return { action: "stop", reasons: [`worth_continuing=${worth.toFixed(1)} <= stop line ${policy.pulse.stopScore}`] };
  }
  if (repeating >= policy.pulse.repeatNoul) {
    reasons.push(`repeating=${repeating.toFixed(2)} >= ${policy.pulse.repeatNoul}`);
  }
  if (stuck >= policy.pulse.stuckNoul) {
    reasons.push(`stuck on same error=${stuck.toFixed(2)} >= ${policy.pulse.stuckNoul}`);
  }
  if (progressing <= policy.pulse.progressNoul) {
    reasons.push(`not progressing=${progressing.toFixed(2)} <= ${policy.pulse.progressNoul}`);
  }
  if (reasons.length > 0) return { action: "intervene", reasons };

  return { action: "continue", reasons };
}

export function decideSteer(answers: Record<string, Answer>, policy: Policy): SteerDecision {
  const tier = answers.model_tier?.type === "choice" ? answers.model_tier : undefined;
  if (!tier || tier.choice !== "mini") {
    return { tier: "frontier", reasons: ["default frontier"] };
  }
  if (tier.confidence >= policy.steer.miniConfidence) {
    return { tier: "mini", reasons: [`mini at confidence ${tier.confidence.toFixed(2)}`] };
  }
  return { tier: "frontier", reasons: [`mini chosen but confidence ${tier.confidence.toFixed(2)} below bar`] };
}

export interface ReflexIds {
  sessionId: string;
  taskId?: string;
  turnId?: string;
}

export interface ReflexEngineDeps {
  systemOne: SystemOne;
  journal: Journal;
  policy?: Policy;
  environment?: string;
  root: string;
  makeId?: () => string;
  ids?: () => ReflexIds;
  budgets?: BudgetLimits;
  knownSpendUsd?: number;
  signal?: AbortSignal;
  now?: () => number;
}

type Judgment = JudgmentOutcome & {
  judgmentId: string;
  answers?: Record<string, Answer>;
  groups?: Record<string, Record<string, Answer> | null>;
};

export class ReflexEngine {
  private readonly systemOne: SystemOne;
  private readonly journal: Journal;
  readonly policy: Policy;
  private readonly environment: string;
  private readonly root: string;
  private readonly makeId: () => string;
  private readonly ids: () => ReflexIds;
  private readonly budgetLimits: BudgetLimits;
  private readonly knownSpendUsd: number | "unknown";
  private readonly signal?: AbortSignal;
  private readonly now: () => number;
  private readonly startedAt: number;
  private modelCalls = 0;

  constructor(deps: ReflexEngineDeps) {
    this.systemOne = deps.systemOne;
    this.journal = deps.journal;
    this.policy = deps.policy ?? policyForTrust(0.3);
    this.environment = deps.environment ?? "A git repository in the current working directory.";
    this.root = deps.root;
    this.makeId = deps.makeId ?? (() => newId("j"));
    this.ids = deps.ids ?? (() => ({ sessionId: "" }));
    this.budgetLimits = deps.budgets ?? {};
    this.knownSpendUsd = deps.knownSpendUsd ?? "unknown";
    this.signal = deps.signal;
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  noteModelCall(): void {
    this.modelCalls += 1;
  }

  enforceBudgets(): BudgetCheck {
    return checkBudgets(
      { modelCalls: this.modelCalls, elapsedMs: this.now() - this.startedAt, knownSpendUsd: this.knownSpendUsd },
      this.budgetLimits,
    );
  }

  private askOptions(): AskOptions {
    const options: AskOptions = { deadlineMs: this.policy.jev.deadlineMs };
    if (this.signal) options.signal = this.signal;
    return options;
  }

  private budgetReason(): string | null {
    const check = this.enforceBudgets();
    if (check.ok) return null;
    return `budget exceeded: ${check.breached.join(", ")}`;
  }

  private async request(
    reflex: string,
    subject: string,
    state: unknown,
    questions: Record<string, Question>,
    groups?: Record<string, string[]>,
  ): Promise<Judgment> {
    const judgmentId = this.makeId();
    const record = (status: ReflexStatus, result: AskResult | null, reason?: string): void => {
      this.recordReflex(reflex, subject, state, questions, result, judgmentId, status, reason);
    };

    const budget = this.budgetReason();
    if (budget !== null) {
      record("unavailable", null, budget);
      return { status: "unavailable", reason: budget, judgmentId };
    }

    try {
      const result = await this.systemOne.ask(state, questions, this.askOptions());
      if (!groups) {
        const answers = validateAnswers(questions, result.answers);
        record("completed", result);
        return { status: "completed", result, judgmentId, answers };
      }
      const { groups: valid, errors } = validateGroups(questions, result.answers, groups);
      if (Object.keys(errors).length === 0) {
        const answers = Object.assign({}, ...Object.values(valid)) as Record<string, Answer>;
        record("completed", result);
        return { status: "completed", result, judgmentId, answers };
      }
      const reason = Object.entries(errors)
        .map(([name, message]) => `${name}: ${message}`)
        .join("; ");
      record("unavailable", null, reason);
      return { status: "unavailable", reason, judgmentId, groups: valid };
    } catch (error) {
      if (error instanceof JevCancelledError) {
        record("cancelled", null, error.message);
        return { status: "cancelled", reason: error.message, judgmentId };
      }
      const reason =
        error instanceof JevUnavailableError ? error.message : `judgment failed: ${error instanceof Error ? error.message : String(error)}`;
      record("unavailable", null, reason);
      return { status: "unavailable", reason, judgmentId };
    }
  }

  private fallbackGate(floor: StaticVerdict, cause: string): GateDecision {
    if (floor === "ask") return { action: "ask", reasons: ["static floor: risky pattern", cause] };
    return { action: "ask", reasons: ["judgment unavailable", cause] };
  }

  private fallbackSanitize(cause: string): SanitizeDecision {
    return { action: "block", reasons: ["sanitizer unavailable — content withheld", cause] };
  }

  private fallbackVerify(cause: string): VerifyDecision {
    return { action: "ok", reasons: ["verification unavailable — result not verified", cause], verified: false };
  }

  private fallbackPulse(cause: string): PulseDecision {
    return { action: "continue", reasons: ["pulse unavailable", cause] };
  }

  private fallbackSteer(cause: string): SteerDecision {
    return { tier: "frontier", reasons: ["steer unavailable — using main model", cause] };
  }

  async gate(input: GateInput): Promise<GateDecision & { result?: AskResult }> {
    const floor = staticVerdict(input.tool, { command: input.command, path: input.path }, this.root);

    if (floor === "deny") {
      const decision: GateDecision = { action: "deny", reasons: ["static floor: dangerous pattern"] };
      this.recordDecision("gate", decision, input.command, { staticVerdict: "deny" });
      return decision;
    }

    const state = {
      task: input.task,
      environment: this.environment,
      action: { tool: input.tool, command: input.command },
    };
    const questions = gateQuestions(input.command, input.task);
    const judgment = await this.request("gate", input.command, state, questions);

    if (judgment.status !== "completed") {
      const decision = this.fallbackGate(floor, judgment.reason);
      this.recordDecision("gate", decision, input.command, { judgmentId: judgment.judgmentId, staticVerdict: floor });
      return decision;
    }

    let decision = decideGate(judgment.answers!, this.policy);
    if (floor === "ask" && decision.action === "auto") {
      decision = { action: "ask", reasons: ["static floor: risky pattern", ...decision.reasons] };
    }
    this.recordDecision("gate", decision, input.command, { judgmentId: judgment.judgmentId, staticVerdict: floor });
    return { ...decision, result: judgment.result };
  }

  async sanitize(content: string, source: string): Promise<SanitizeDecision & { result: AskResult | null }> {
    const observed = await this.observeToolResult(content, source, "unspecified tool call");
    return { ...observed.sanitize, result: observed.result };
  }

  async observeToolResult(
    content: string,
    source: string,
    intent: string,
  ): Promise<{ sanitize: SanitizeDecision; verify: VerifyDecision; result: AskResult | null }> {
    const state = {
      situation:
        "A coding agent is working in a repository and just read this content as the output of a tool (a file, command output, or web page).",
      intent,
      content,
    };
    const questions = { ...sanitizeQuestions(), ...verifyQuestions() };
    const judgment = await this.request("sanitize", source, state, questions, sanitizeVerifyGroups());

    let sanitize: SanitizeDecision;
    let verify: VerifyDecision;
    let result: AskResult | null = null;
    if (judgment.status === "completed") {
      sanitize = decideSanitize(judgment.answers!, this.policy);
      verify = decideVerify(judgment.answers!, this.policy);
      result = judgment.result;
    } else {
      // A broken group must not invalidate its sibling: a still-valid sanitize group decides normally.
      const sanitizeValid = judgment.groups?.sanitize ?? null;
      sanitize = sanitizeValid !== null ? decideSanitize(sanitizeValid, this.policy) : this.fallbackSanitize(judgment.reason);
      const verifyValid = judgment.groups?.verify ?? null;
      // verified is true only when the judgment completed; a group that merely validated within a
      // failed judgment is still not a positive verification.
      verify =
        verifyValid !== null
          ? { ...decideVerify(verifyValid, this.policy), verified: false }
          : this.fallbackVerify(judgment.reason);
    }
    this.recordDecision("sanitize", sanitize, source, { judgmentId: judgment.judgmentId });
    this.recordDecision("verify", verify, source, { judgmentId: judgment.judgmentId });
    return { sanitize, verify, result };
  }

  async pulse(input: { task: string; events: string[]; budget: string }): Promise<PulseDecision & { result: AskResult | null }> {
    const state = {
      task: input.task,
      recent_events: input.events,
      budget: input.budget,
    };
    const questions = pulseQuestions();
    const judgment = await this.request("pulse", input.task, state, questions);

    if (judgment.status !== "completed") {
      const decision = this.fallbackPulse(judgment.reason);
      this.recordDecision("pulse", decision, input.task, { judgmentId: judgment.judgmentId });
      return { ...decision, result: null };
    }

    const decision = decidePulse(judgment.answers!, this.policy);
    this.recordDecision("pulse", decision, input.task, { judgmentId: judgment.judgmentId });
    return { ...decision, result: judgment.result };
  }

  async steer(input: { task: string; events: string[] }): Promise<SteerDecision & { result: AskResult | null }> {
    const state = {
      task: input.task,
      recent_events: input.events,
    };
    const questions = steerQuestions();
    const judgment = await this.request("steer", input.task, state, questions);

    if (judgment.status !== "completed") {
      const decision = this.fallbackSteer(judgment.reason);
      this.recordDecision("steer", { action: decision.tier, reasons: decision.reasons }, input.task, { judgmentId: judgment.judgmentId });
      return { ...decision, result: null };
    }

    const decision = decideSteer(judgment.answers!, this.policy);
    this.recordDecision("steer", { action: decision.tier, reasons: decision.reasons }, input.task, { judgmentId: judgment.judgmentId });
    return { ...decision, result: judgment.result };
  }

  private recordReflex(
    reflex: string,
    subject: string,
    state: unknown,
    questions: Record<string, Question>,
    result: AskResult | null,
    judgmentId: string,
    status: ReflexStatus = "completed",
    reason?: string,
  ): void {
    const ids = this.ids();
    this.journal.append({
      t: "reflex",
      v: 2,
      sessionId: ids.sessionId,
      ...(ids.taskId !== undefined ? { taskId: ids.taskId } : {}),
      ...(ids.turnId !== undefined ? { turnId: ids.turnId } : {}),
      judgmentId,
      ts: Date.now(),
      reflex,
      subject,
      status,
      state,
      questions,
      result,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  private recordDecision(
    reflex: string,
    decision: { action: string; reasons: string[] },
    subject: string,
    opts?: { judgmentId?: string; staticVerdict?: StaticVerdict },
  ): void {
    this.journal.append({
      t: "decision",
      v: 2,
      ...(opts?.judgmentId !== undefined ? { judgmentId: opts.judgmentId } : {}),
      ts: Date.now(),
      reflex,
      action: decision.action,
      reasons: decision.reasons,
      ...(opts?.staticVerdict !== undefined ? { staticVerdict: opts.staticVerdict } : {}),
    });
  }
}
