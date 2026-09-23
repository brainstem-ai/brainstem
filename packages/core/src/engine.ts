import { checkBudgets, type BudgetCheck, type BudgetLimits } from "./budgets";
import { createBitmap, popcount, type CapabilityBitmap } from "./bitmap";
import { computeCacheKey, type AnswerCache } from "./cache";
import { hashAction, newId } from "./evidence";
import { boundForReview, REVIEW_CHAR_CAP } from "./presentation";
import type { CapabilityCatalog } from "./capabilities";
import type { ToolStatus } from "./evidence";
import { JevCancelledError, JevUnavailableError } from "./errors";
import { staticVerdict, type StaticVerdict } from "./floor";
import type { Journal, ReflexStatus } from "./journal";
import { policyForTrust, type Policy } from "./policy";
import { gateQuestions, pulseQuestions, sanitizeQuestions, sanitizeVerifyGroups, steerQuestions, verifyQuestions } from "./questions";
import type { Answer, AskOptions, AskResult, JudgmentOutcome, Question, SystemOne } from "./types";
import { validateAnswers, validateGroups } from "./validation";
import {
  batchCandidates,
  buildEvaluatedBitmap,
  buildFallbackDecision,
  buildSelectQuestions,
  decideSelect,
  eligibleForSelection,
  encodeSelectId,
  type SelectDecision,
  type SelectInput,
  SELECT_BATCH_CHAR_BUDGET,
} from "./selection";
import {
  assembleFocusDecision,
  batchSections,
  buildExhaustiveDecision,
  buildFallbackDecision as buildFocusFallbackDecision,
  buildFocusQuestions,
  decideFocus,
  isExhaustiveTask,
  type FocusDecision,
  type FocusInput,
  FOCUS_BATCH_CHAR_BUDGET,
} from "./output-focus";

export type GateAction = "auto" | "ask" | "deny";

export interface GateDecision {
  action: GateAction;
  reasons: string[];
}

export interface GateInput {
  tool: string;
  task: string;
  command?: string;
  path?: string;
  changeSummary?: string;
  evidenceIncomplete?: boolean;
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

export type SteerTier = "frontier" | "mini";

export interface SteerInput {
  task: string;
  events: string[];
  latestObservation?: string;
  capabilities?: string[];
}

export interface SteerOptions {
  // Maps the chosen tier to the model id that will actually serve the request;
  // the harness knows this because it performs the routing.
  resolveModelId?: (tier: SteerTier) => string;
}

// Kept as an alias so existing call sites and journal fields referencing
// "content cap" still resolve to the one shared review boundary in
// ./presentation, rather than a second independently-maintained number.
const CONTENT_CAP = REVIEW_CHAR_CAP;
const INTENT_CAP = 300;

export interface ObservationEnvelope {
  task: string;
  source: string;
  actionSummary: string;
  intent: string;
  status: ToolStatus;
  truncated: boolean;
  content: string;
}

export interface ObserveToolResultInput {
  task: string;
  source: string;
  actionSummary: string;
  intent?: string;
  status?: ToolStatus;
  truncated?: boolean;
  content: string;
}

export function buildEnvelope(input: ObserveToolResultInput): ObservationEnvelope {
  return {
    task: input.task,
    source: input.source,
    actionSummary: input.actionSummary,
    intent: (input.intent ?? input.actionSummary).slice(0, INTENT_CAP),
    status: input.status ?? "ok",
    // A caller-supplied envelope is already expected to be pre-bounded by the
    // single presentation boundary (see ./presentation); this is a defensive
    // backstop, not a second independent slice — if it ever fires, the
    // envelope inherits the truncation the caller may not have reported.
    truncated: input.truncated ?? boundForReview(input.content, CONTENT_CAP).truncated,
    content: boundForReview(input.content, CONTENT_CAP).text,
  };
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
  const success = answers.evidence_of_success?.type === "noul" ? answers.evidence_of_success.noul : 1;
  const operational = answers.operational_failure?.type === "noul" ? answers.operational_failure.noul : 0;

  // Operational failure alone never implies mismatch: reproducing a failing test is
  // a legitimate, satisfying outcome — it is recorded as context, not as a verdict.
  if (operational >= policy.confidenceFloor) {
    reasons.push(`operational failure=${operational.toFixed(2)} — the tool itself failed to run; reproducing that failure is legitimate`);
  }

  if (satisfied < policy.confidenceFloor && success < policy.confidenceFloor) {
    return {
      action: "mismatch",
      reasons: [
        ...reasons,
        `satisfies_intent=${satisfied.toFixed(2)} and evidence_of_success=${success.toFixed(2)} below floor ${policy.confidenceFloor}`,
      ],
      verified: true,
    };
  }
  return { action: "ok", reasons, verified: true };
}

export interface RepeatedAction {
  label: string;
  count: number;
}

export interface PulseFacts {
  recentActions: { tool: string; summary: string; status: ToolStatus }[];
  repeatedActionCounts: RepeatedAction[];
  failureFingerprints: { fingerprint: string; count: number }[];
  approachChanged: boolean;
}

const STEER_CAPABILITY_CAP = 12;

function gateSubject(input: GateInput): string {
  return input.command ?? input.path ?? input.tool;
}

export interface PulseDecideFacts {
  repeatedAction?: RepeatedAction;
}

export function decidePulse(answers: Record<string, Answer>, policy: Policy, facts: PulseDecideFacts = {}): PulseDecision {
  const reasons: string[] = [];
  const repeating = answers.repeating?.type === "noul" ? answers.repeating.noul : 0;
  const approachChanged = answers.approach_changed?.type === "noul" ? answers.approach_changed.noul : 0;
  const progressing = answers.progressing?.type === "noul" ? answers.progressing.noul : 1;
  const stuck = answers.stuck_on_same_error?.type === "noul" ? answers.stuck_on_same_error.noul : 0;
  const worth = answers.worth_continuing?.type === "score" ? answers.worth_continuing.score : 2;

  if (worth <= policy.pulse.stopScore) {
    return { action: "stop", reasons: [`worth_continuing=${worth.toFixed(1)} <= stop line ${policy.pulse.stopScore}`] };
  }
  // A genuine change of approach between attempts means the repetition is not
  // thrashing — do not fire the repeating reason for it.
  if (repeating >= policy.pulse.repeatNoul && approachChanged < 0.5) {
    const repeated = facts.repeatedAction;
    if (repeated && repeated.count >= 2) {
      reasons.push(`repeating: ${repeated.label} x${repeated.count}`);
    } else {
      reasons.push(`repeating=${repeating.toFixed(2)} >= ${policy.pulse.repeatNoul}`);
    }
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
  cache?: AnswerCache;
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
  private readonly cache?: AnswerCache;
  private readonly inFlight = new Map<string, Promise<Judgment>>();
  private modelCalls = 0;
  private lastPulseIntervention: string | undefined;

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
    this.cache = deps.cache;
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

  // Non-throwing re-validation for a cache hit: a schema mismatch on reuse
  // (e.g. the question table changed shape since this was cached) falls
  // through to a fresh call rather than becoming a new failure mode the
  // cache itself introduces.
  private tryRevalidate(
    questions: Record<string, Question>,
    cachedAnswers: Record<string, Answer>,
    groups?: Record<string, string[]>,
  ): Record<string, Answer> | undefined {
    try {
      if (!groups) return validateAnswers(questions, cachedAnswers);
      const { groups: valid, errors } = validateGroups(questions, cachedAnswers, groups);
      if (Object.keys(errors).length > 0) return undefined;
      return Object.assign({}, ...Object.values(valid)) as Record<string, Answer>;
    } catch {
      return undefined;
    }
  }

  private async request(
    reflex: string,
    subject: string,
    state: unknown,
    questions: Record<string, Question>,
    groups?: Record<string, string[]>,
  ): Promise<Judgment> {
    const judgmentId = this.makeId();
    const record = (
      status: ReflexStatus,
      result: AskResult | null,
      reason?: string,
      cacheProvenance?: { cachedFromJudgmentId: string },
    ): void => {
      this.recordReflex(reflex, subject, state, questions, result, judgmentId, status, reason, cacheProvenance);
    };

    const cacheKey = this.cache ? computeCacheKey(this.systemOne.name, state, questions) : undefined;

    // Checked before the budget gate: a hit makes zero new provider calls, so
    // it must never be blocked by a budget that exists to bound new spend,
    // time, or call count.
    if (cacheKey !== undefined) {
      const cached = this.cache!.get(cacheKey);
      if (cached) {
        const answers = this.tryRevalidate(questions, cached.answers, groups);
        if (answers !== undefined) {
          record("completed", cached.result, undefined, { cachedFromJudgmentId: cached.originalJudgmentId });
          return { status: "completed", result: cached.result, judgmentId, answers };
        }
      }
    }

    const budget = this.budgetReason();
    if (budget !== null) {
      record("unavailable", null, budget);
      return { status: "unavailable", reason: budget, judgmentId };
    }

    if (cacheKey !== undefined) {
      const pending = this.inFlight.get(cacheKey);
      if (pending) return pending;
    }

    const attempt = (async (): Promise<Judgment> => {
      try {
        const result = await this.systemOne.ask(state, questions, this.askOptions());
        if (!groups) {
          const answers = validateAnswers(questions, result.answers);
          record("completed", result);
          if (cacheKey !== undefined) {
            this.cache!.set(cacheKey, { answers, result, originalJudgmentId: judgmentId, cachedAt: this.now() });
          }
          return { status: "completed", result, judgmentId, answers };
        }
        const { groups: valid, errors } = validateGroups(questions, result.answers, groups);
        if (Object.keys(errors).length === 0) {
          const answers = Object.assign({}, ...Object.values(valid)) as Record<string, Answer>;
          record("completed", result);
          if (cacheKey !== undefined) {
            this.cache!.set(cacheKey, { answers, result, originalJudgmentId: judgmentId, cachedAt: this.now() });
          }
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
          error instanceof JevUnavailableError
            ? error.message
            : `judgment failed: ${error instanceof Error ? error.message : String(error)}`;
        record("unavailable", null, reason);
        return { status: "unavailable", reason, judgmentId };
      }
    })();

    if (cacheKey !== undefined) {
      const key = cacheKey;
      this.inFlight.set(key, attempt);
      void attempt.finally(() => {
        if (this.inFlight.get(key) === attempt) this.inFlight.delete(key);
      });
    }

    return attempt;
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

  private fallbackSelect(
    catalog: CapabilityCatalog,
    current: CapabilityBitmap,
    available: CapabilityBitmap,
    candidates: import("./selection").SelectableCapability[],
  ): Omit<SelectDecision, "status" | "batches"> {
    return buildFallbackDecision(catalog, current, available, candidates);
  }

  private fallbackFocus(manifest: import("./output-sections").SectionManifest): FocusDecision {
    return { ...buildFocusFallbackDecision(manifest), status: "unavailable", batches: 0 };
  }

  async gate(input: GateInput): Promise<GateDecision & { result?: AskResult }> {
    const floor = staticVerdict(input.tool, { command: input.command, path: input.path }, this.root);

    if (floor === "deny") {
      const decision: GateDecision = { action: "deny", reasons: ["static floor: dangerous pattern"] };
      this.recordDecision("gate", decision, gateSubject(input), { staticVerdict: "deny" });
      return decision;
    }

    // The semantic evidence sent to Jev is separate from the immutable actionHash
    // used for approvals — the hash must never appear in the judgment state.
    const state = {
      task: input.task,
      environment: this.environment,
      action: {
        tool: input.tool,
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
        ...(input.evidenceIncomplete === true ? { evidenceIncomplete: true } : {}),
      },
    };
    const questions = gateQuestions(input.task);
    const judgment = await this.request("gate", gateSubject(input), state, questions);

    if (judgment.status !== "completed") {
      const decision = this.fallbackGate(floor, judgment.reason);
      this.recordDecision("gate", decision, gateSubject(input), { judgmentId: judgment.judgmentId, staticVerdict: floor });
      return decision;
    }

    let decision = decideGate(judgment.answers!, this.policy);
    if (floor === "ask" && decision.action === "auto") {
      decision = { action: "ask", reasons: ["static floor: risky pattern", ...decision.reasons] };
    }
    this.recordDecision("gate", decision, gateSubject(input), { judgmentId: judgment.judgmentId, staticVerdict: floor });
    return { ...decision, result: judgment.result };
  }

  async sanitize(content: string, source: string): Promise<SanitizeDecision & { result: AskResult | null }> {
    const observed = await this.observeToolResult({ task: "unspecified", source, actionSummary: source, content });
    return { ...observed.sanitize, result: observed.result };
  }

  async observeToolResult(
    input: ObserveToolResultInput,
  ): Promise<{ sanitize: SanitizeDecision; verify: VerifyDecision; result: AskResult | null }> {
    const envelope = buildEnvelope(input);
    const state = {
      situation:
        "A coding agent is working in a repository and just read this content as the output of a tool (a file, command output, or web page).",
      ...envelope,
    };
    const questions = { ...sanitizeQuestions(), ...verifyQuestions() };
    const judgment = await this.request("sanitize", envelope.source, state, questions, sanitizeVerifyGroups());

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
      verify = verifyValid !== null ? { ...decideVerify(verifyValid, this.policy), verified: false } : this.fallbackVerify(judgment.reason);
    }
    this.recordDecision("sanitize", sanitize, envelope.source, { judgmentId: judgment.judgmentId });
    this.recordDecision("verify", verify, envelope.source, { judgmentId: judgment.judgmentId });
    return { sanitize, verify, result };
  }

  async pulse(input: {
    task: string;
    events: string[];
    budget: string;
    facts?: PulseFacts;
    actionHashes?: string[];
  }): Promise<PulseDecision & { result: AskResult | null }> {
    const state = {
      task: input.task,
      recent_events: input.events,
      budget: input.budget,
      ...(input.facts !== undefined
        ? {
            facts: {
              recent_actions: input.facts.recentActions,
              repeated_actions: input.facts.repeatedActionCounts,
              repeated_failures: input.facts.failureFingerprints,
              approach_changed: input.facts.approachChanged,
            },
          }
        : {}),
    };
    const questions = pulseQuestions();
    const judgment = await this.request("pulse", input.task, state, questions);

    if (judgment.status !== "completed") {
      const decision = this.fallbackPulse(judgment.reason);
      this.recordDecision("pulse", decision, input.task, { judgmentId: judgment.judgmentId });
      return { ...decision, result: null };
    }

    const repeatedAction = (input.facts?.repeatedActionCounts ?? []).filter((e) => e.count >= 2).sort((a, b) => b.count - a.count)[0];
    let decision = decidePulse(judgment.answers!, this.policy, { repeatedAction });

    if (decision.action === "intervene") {
      const fingerprint = hashAction({ reasons: decision.reasons, actionHashes: input.actionHashes ?? [] });
      if (fingerprint === this.lastPulseIntervention) {
        decision = { action: "continue", reasons: ["intervention already active"] };
      } else {
        this.lastPulseIntervention = fingerprint;
      }
    }
    this.recordDecision("pulse", decision, input.task, { judgmentId: judgment.judgmentId });
    return { ...decision, result: judgment.result };
  }

  async steer(input: SteerInput, opts: SteerOptions = {}): Promise<SteerDecision & { result: AskResult | null }> {
    const state = {
      task: input.task,
      recent_events: input.events,
      ...(input.latestObservation !== undefined ? { latest_observation: input.latestObservation } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities.slice(0, STEER_CAPABILITY_CAP) } : {}),
    };
    const questions = steerQuestions();
    const judgment = await this.request("steer", input.task, state, questions);

    if (judgment.status !== "completed") {
      const decision = this.fallbackSteer(judgment.reason);
      this.recordSteer(decision.tier, decision.reasons, input.task, judgment.judgmentId, opts.resolveModelId);
      return { ...decision, result: null };
    }

    const decision = decideSteer(judgment.answers!, this.policy);
    this.recordSteer(decision.tier, decision.reasons, input.task, judgment.judgmentId, opts.resolveModelId);
    return { ...decision, result: judgment.result };
  }

  async select(input: SelectInput): Promise<SelectDecision> {
    const candidates = eligibleForSelection(input.catalog, input.available, input.baseline, input.explicit);
    if (candidates.length === 0) {
      const empty = createBitmap(input.catalog.catalogHash, input.catalog.entries.length);
      return { evaluated: empty, recommended: empty, scores: {}, reasons: {}, status: "ok", batches: 0 };
    }

    const batches = batchCandidates(candidates, SELECT_BATCH_CHAR_BUDGET);
    const mergedAnswers: Record<string, Answer> = {};
    let completedCount = 0;
    let lastJudgmentId: string | undefined;
    const subject = input.task.slice(0, 80);

    for (const batch of batches) {
      const questions = buildSelectQuestions(batch);
      const descriptors = batch.map((c) => ({
        id: c.descriptor.id,
        description: c.descriptor.description,
        useWhen: c.descriptor.useWhen,
        avoidWhen: c.descriptor.avoidWhen,
      }));
      const state = {
        task: input.task,
        recent: input.recent,
        ...(input.discoveryQuery !== undefined ? { discoveryQuery: input.discoveryQuery } : {}),
        candidates: descriptors,
      };
      const judgment = await this.request("select", subject, state, questions);
      lastJudgmentId = judgment.judgmentId;
      if (judgment.status === "completed" && judgment.answers) {
        completedCount++;
        Object.assign(mergedAnswers, judgment.answers);
      }
    }

    if (completedCount === 0) {
      const partial = this.fallbackSelect(input.catalog, input.current, input.available, candidates);
      const decision: SelectDecision = { ...partial, status: "unavailable", batches: batches.length };
      this.recordDecision(
        "select",
        {
          action: decision.status,
          reasons: [String(decision.batches), String(popcount(decision.recommended)), input.catalog.catalogHash.slice(0, 16)],
        },
        subject,
        { judgmentId: lastJudgmentId },
      );
      return decision;
    }

    const { recommended, scores, reasons } = decideSelect(input.catalog, candidates, mergedAnswers, input.current, this.policy);
    const evaluated = buildEvaluatedBitmap(input.catalog, candidates, mergedAnswers);
    const status: SelectDecision["status"] = completedCount === batches.length ? "ok" : "partial";
    const decision: SelectDecision = { evaluated, recommended, scores, reasons, status, batches: batches.length };
    this.recordDecision(
      "select",
      {
        action: decision.status,
        reasons: [String(decision.batches), String(popcount(decision.recommended)), input.catalog.catalogHash.slice(0, 16)],
      },
      subject,
      { judgmentId: lastJudgmentId },
    );
    return decision;
  }

  async focus(input: FocusInput): Promise<FocusDecision> {
    if (isExhaustiveTask(input)) {
      const decision = buildExhaustiveDecision(input.manifest);
      this.recordDecision(
        "focus",
        {
          action: decision.mode,
          reasons: [String(decision.batches), String(popcount(decision.selected)), input.manifest.catalogHash.slice(0, 16)],
        },
        input.command.slice(0, 80),
      );
      return decision;
    }

    const candidates = input.manifest.entries;
    const batches = batchSections(candidates, FOCUS_BATCH_CHAR_BUDGET);
    const mergedAnswers: Record<string, Answer> = {};
    let completedCount = 0;
    let lastJudgmentId: string | undefined;
    const subject = input.command.slice(0, 80);

    for (const batch of batches) {
      const questions = buildFocusQuestions(batch);
      const sections = batch.map((s) => ({ id: s.id, text: s.text.slice(0, 2_000) }));
      const state = {
        task: input.task,
        command: input.command,
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        outcome: input.outcome,
        recentFindings: input.recentFindings,
        sections,
      };
      const judgment = await this.request("focus", subject, state, questions);
      lastJudgmentId = judgment.judgmentId;
      if (judgment.status === "completed" && judgment.answers) {
        completedCount++;
        Object.assign(mergedAnswers, judgment.answers);
      }
    }

    if (completedCount === 0) {
      const decision = this.fallbackFocus(input.manifest);
      this.recordDecision(
        "focus",
        {
          action: decision.mode,
          reasons: [String(decision.batches), String(popcount(decision.selected)), input.manifest.catalogHash.slice(0, 16)],
        },
        subject,
        { judgmentId: lastJudgmentId },
      );
      return decision;
    }

    const inner = decideFocus(input.manifest, candidates, mergedAnswers, this.policy, input.budgetChars);
    const status: FocusDecision["status"] = completedCount === batches.length ? "ok" : "partial";
    const decision = assembleFocusDecision(input.manifest, inner, status, batches.length);
    this.recordDecision(
      "focus",
      {
        action: decision.mode,
        reasons: [String(decision.batches), String(popcount(decision.selected)), input.manifest.catalogHash.slice(0, 16)],
      },
      subject,
      { judgmentId: lastJudgmentId },
    );
    return decision;
  }

  private recordSteer(
    tier: SteerTier,
    reasons: string[],
    subject: string,
    judgmentId: string,
    resolveModelId?: (tier: SteerTier) => string,
  ): void {
    const usedModelId = resolveModelId?.(tier);
    this.journal.append({
      t: "decision",
      v: 2,
      judgmentId,
      ts: Date.now(),
      reflex: "steer",
      action: tier,
      reasons,
      ...(usedModelId !== undefined ? { model: usedModelId } : {}),
    });
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
    cacheProvenance?: { cachedFromJudgmentId: string },
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
      ...(cacheProvenance !== undefined ? { cacheHit: true, cachedFromJudgmentId: cacheProvenance.cachedFromJudgmentId } : {}),
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
