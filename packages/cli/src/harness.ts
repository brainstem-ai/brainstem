import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Message, Model, Api } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ReflexEngine,
  ARTIFACT_SCHEMA_VERSION,
  BoundedAnswerCache,
  boundForReview,
  REVIEW_CHAR_CAP,
  contentHash,
  countLines,
  splitIntoSections,
  toIds,
  hashAction,
  newId,
  openJournal,
  policyForTrust,
  staticVerdict,
  type AnswerCache,
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalStatus,
  type ArtifactRecord,
  type FocusDecision,
  type Journal,
  type SectionManifest,
  type SystemOne,
  type ToolObservation,
  type ToolStatus,
  type TurnSpans,
} from "@brainstem/core";
import { buildActiveContext } from "./capabilities/context";
import { makeDiscoveryTool } from "./capabilities/discovery";
import { CapabilityRegistry } from "./capabilities/registry";
import { SelectDriver } from "./capabilities/select-policy";
import { loadSkillsFromRoot } from "./capabilities/skills";
import { ABSENT_DIGEST, changeSummaryForWrite } from "./change-summary";
import { checkWriteTarget, isInside } from "./paths";
import { SessionRecorder } from "./session";
import { makeTools } from "./tools";
import { LocalArtifactStore } from "./output/artifact-store";
import { FOCUS_PRESENT_BUDGET_CHARS, presentArtifact, type FocusRolloutMode } from "./output/present";
import { makeRecoveryTools } from "./output/recovery-tools";

export const DEFAULT_SYSTEM_PROMPT = `You are a careful coding agent. Work inside the project directory. Prefer small, verifiable steps: run tests, read before writing, and keep the user informed. If a tool result says the harness blocked or flagged something, surface that to the user in your reply.`;

export interface HarnessOptions {
  systemOne: SystemOne;
  streamFn: StreamFn;
  model: Model<Api>;
  miniModel?: Model<Api>;
  trust: number;
  journalPath: string;
  cwd: string;
  systemPrompt?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  approvalHandler?: ApprovalHandler;
  registry?: CapabilityRegistry;
  answerCache?: AnswerCache;
  skillRoots?: string[];
  focusMode?: FocusRolloutMode;
  pulseEveryTurns?: number;
  signal?: AbortSignal;
  onReflex?: (line: string) => void;
  onDelta?: (delta: string) => void;
}

export interface Harness {
  agent: Agent;
  engine: ReflexEngine;
  journal: Journal;
  recorder: SessionRecorder;
  journalPath: string;
  approvalsRequested(): number;
  prompt(text: string): Promise<void>;
  endSession(reason?: "normal" | "error", error?: string): void;
}

const EXCERPT_CAP = 2_000;
const STEER_CAPABILITY_CAP = 12;
const CAPTURED_TOOLS = new Set(["bash", "read", "write", "grep", "glob"]);
const RECOVERY_TOOLS = new Set(["read_output", "search_output"]);

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

interface ToolDetails {
  status?: ToolStatus;
  exit?: number;
  durationMs?: number;
  truncated?: boolean;
  // bash: separate captured streams (see packages/cli/src/tools.ts).
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutText?: string;
  stderrText?: string;
  stdoutObservedBytes?: number;
  stderrObservedBytes?: number;
  stdoutComplete?: boolean;
  stderrComplete?: boolean;
  // read: bounded-streaming file read (see packages/cli/src/tools.ts).
  sourceBytes?: number;
  retainedBytes?: number;
}

function detailsOf(result: unknown): ToolDetails {
  return (result as { details?: ToolDetails } | undefined)?.details ?? {};
}

function actionLabel(tool: string, args: unknown): string {
  const a = (args ?? {}) as { command?: string; path?: string; pattern?: string };
  const subject = a.command ?? a.path ?? a.pattern;
  return subject === undefined ? tool : `${tool}: ${subject.slice(0, 80)}`;
}

function argsSummaryFor(args: unknown): unknown {
  if (args === null || typeof args !== "object") return args ?? {};
  const { content: _content, ...rest } = args as Record<string, unknown>;
  return rest;
}

// R3: the action hash used for approval must include write CONTENT identity
// (digest + length), not just the args with content stripped out — otherwise
// approval of "write path X with content A" is indistinguishable from
// approval of "write path X with content B". `v` versions the hash schema:
// a formula change here naturally invalidates any historical hash, since a
// differently-versioned hash can never equal one computed under this
// version.
const ACTION_HASH_SCHEMA_VERSION = 1;

function actionIdentity(tool: string, args: unknown, extra: { target?: string; preconditionDigest?: string } = {}): unknown {
  const content = (args as { content?: string } | undefined)?.content;
  return {
    v: ACTION_HASH_SCHEMA_VERSION,
    tool,
    ...(argsSummaryFor(args) as object),
    ...(typeof content === "string"
      ? { contentDigest: contentHash(content), contentLength: Buffer.byteLength(content, "utf8") }
      : {}),
    ...(extra.target !== undefined ? { target: extra.target } : {}),
    ...(extra.preconditionDigest !== undefined ? { preconditionDigest: extra.preconditionDigest } : {}),
  };
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function createHarness(options: HarnessOptions): Harness {
  const policy = policyForTrust(options.trust);
  const journal = openJournal(options.journalPath);
  const recorder = new SessionRecorder(journal, options.cwd, { policy, trust: options.trust });

  const engine = new ReflexEngine({
    systemOne: options.systemOne,
    journal,
    policy,
    root: options.cwd,
    environment: `Working directory: ${options.cwd}. A git repository.`,
    makeId: () => newId("j"),
    ids: () => ({
      sessionId: recorder.sessionId,
      ...(recorder.currentTask !== undefined ? { taskId: recorder.currentTask.id } : {}),
      ...(recorder.currentTurnId !== undefined ? { turnId: recorder.currentTurnId } : {}),
    }),
    budgets: policy.budgets,
    signal: options.signal,
    cache: options.answerCache ?? new BoundedAnswerCache(),
  });

  const taskText = () => recorder.currentTask?.objective ?? "unspecified";

  const render = (reflex: string, action: string, reasons: string[]) =>
    `[${reflex}] ${action}${reasons.length > 0 ? ` — ${reasons[0]}` : ""}`;

  function gateBlock(reason: string): { block: true; reason: string } {
    return { block: true, reason: `[brainstem] ${reason} Ask the user to confirm, and re-run only if they approve.` };
  }

  // Session-scoped: <journal-parent>/sessions/<sessionId>/artifacts, keyed by
  // the SessionRecorder-generated id (never a timestamp-only directory name)
  // so concurrent sessions sharing a journal parent directory can never read
  // or evict each other's artifacts (R7). Pre-existing shared-directory
  // artifacts from older sessions are simply never looked at by a new
  // session — this does not delete or migrate them (see README).
  const artifactStore = new LocalArtifactStore(
    join(dirname(options.journalPath), "sessions", recorder.sessionId, "artifacts"),
    recorder.sessionId,
  );
  const registry = options.registry ?? new CapabilityRegistry();
  const driver = new SelectDriver({ registry, engine, minRefreshIntervalMs: 0 });

  // Keyed by toolCallId: set by the write gate flow below right before a
  // write is allowed to proceed (auto or approved), consumed once by the
  // write tool's own execute() — see tools.ts's ToolDeps.writePreconditions
  // doc comment for why this is the only channel available to bind a
  // write's preimage through to execution.
  const writePreconditions = new Map<string, string>();

  const tools: AgentTool[] = [
    ...makeTools({ cwd: options.cwd, writePreconditions }),
    ...makeRecoveryTools({ store: artifactStore }),
    makeDiscoveryTool({
      registry,
      driver,
      taskText,
      recentActivity: () => summarizeMessages(agent?.state.messages ?? []),
    }),
  ];
  for (const t of tools) registry.attachImpl(`tool:${t.name}`, t);

  for (const root of options.skillRoots ?? []) {
    for (const skill of loadSkillsFromRoot(root, [options.cwd, ...(options.skillRoots ?? [])])) {
      registry.registerSkill(skill);
    }
  }

  const initialWs = registry.workingSet();
  const initialBuilt = buildActiveContext(registry, initialWs);
  let appliedIdsKey = initialBuilt.activeIds.join(",");
  let appliedInstructionHash: string | undefined = initialBuilt.instructionHash;
  let lastTaskRevision = 0;

  // Capability descriptions are evidence for Steer only. Relevance never grants
  // execution permission, so this is read off the active set and nothing more.
  function activeCapabilityDescriptions(): string[] {
    try {
      const catalog = registry.snapshot();
      const active = registry.workingSet().active;
      const byId = new Map(catalog.entries.map((d) => [d.id, d.description]));
      return toIds(active, catalog.entries)
        .slice(0, STEER_CAPABILITY_CAP)
        .map((id) => `${id}: ${byId.get(id) ?? ""}`);
    } catch {
      return [];
    }
  }

  function textOfAny(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return textOf(content as { type: string; text?: string }[]);
  }

  let turnsCompleted = 0;
  let turnJevMs = 0;
  let turnModelMs = 0;
  let approvalsRequestedCount = 0;

  async function timedJev<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      turnJevMs += performance.now() - t0;
    }
  }

  function summarizeMessages(messages: { role: string; content?: unknown }[]): string[] {
    const lines = recorder.recentActivity(5);
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) {
      const text = textOfAny(lastAssistant.content).slice(0, 140).replace(/\n/g, " ");
      lines.push(`assistant: ${text || "(tool calls)"}`);
    }
    return lines;
  }

  function emitObservation(
    obs: ToolObservation,
    deliveredExcerpt: string,
    deliveredTruncated: boolean,
    deliveredWhy?: string,
  ): void {
    recorder.recordObservation(obs);
    journal.append({
      t: "tool_observation",
      v: 2,
      toolCallId: obs.toolCallId,
      turnId: recorder.currentTurnId ?? "",
      ts: Date.now(),
      observation: obs,
      deliveredExcerpt,
      deliveredTruncated,
      ...(deliveredWhy !== undefined ? { deliveredWhy } : {}),
    });
  }

  function emitBlockedObservation(
    toolCallId: string,
    tool: string,
    args: unknown,
    delivered: string,
    why: string,
  ): void {
    recorder.recordAction(hashAction(actionIdentity(tool, args)), actionLabel(tool, args));
    emitObservation(
      {
        toolCallId,
        tool,
        argsSummary: argsSummaryFor(args),
        status: "blocked",
        durationMs: 0,
        excerpt: delivered,
        truncated: false,
      },
      delivered,
      false,
      why,
    );
  }

  interface ApprovalPrepared {
    target?: string;
    changeSummary?: string;
    preconditionDigest?: string;
    /** Re-verified immediately before consuming approval: target identity and preimage must not have changed underneath a pending request. */
    recheck?: () => { changed: boolean; reason: string };
  }

  async function runApproval(
    toolCallId: string,
    tool: string,
    args: unknown,
    reasons: string[],
    signal: AbortSignal | undefined,
    prepared: ApprovalPrepared = {},
  ): Promise<{ block: true; reason: string } | undefined> {
    // Approval binds to the validated args of this beforeToolCall invocation: args
    // are fixed within one hook call, so the hash recorded at request time is
    // re-checked at resolution time against those same validated inputs. The
    // hash identity includes write content digest+length and the canonical
    // target/precondition (see actionIdentity), so approving one write can
    // never be reinterpreted as approving a different target or payload.
    const approvalId = newId("appr");
    const taskId = recorder.currentTask?.id ?? "";
    const actionHash = hashAction(
      actionIdentity(tool, args, { target: prepared.target, preconditionDigest: prepared.preconditionDigest }),
    );
    const request: ApprovalRequest = {
      id: approvalId,
      taskId,
      toolCallId,
      cwd: options.cwd,
      tool,
      // Defensive read-only snapshot: JSON round-trip so a handler cannot
      // mutate the object the execution wrapper will later re-hash from.
      validatedArgs: args === undefined ? {} : (JSON.parse(JSON.stringify(args)) as unknown),
      actionHash,
      reasons,
      ...(prepared.target !== undefined ? { target: prepared.target } : {}),
      ...(prepared.changeSummary !== undefined ? { changeSummary: prepared.changeSummary } : {}),
    };
    approvalsRequestedCount += 1;
    const appendApproval = (status: ApprovalStatus, why?: string) =>
      journal.append({
        t: "approval",
        v: 2,
        approvalId,
        ts: Date.now(),
        status,
        taskId,
        toolCallId,
        actionHash,
        reasons: why !== undefined ? [why] : reasons,
      });
    appendApproval("requested");

    if (!options.approvalHandler) {
      appendApproval("invalidated", "no handler");
      const reason = gateBlock(`needs approval: ${reasons.join("; ")}`).reason;
      emitBlockedObservation(toolCallId, tool, args, reason, "gate ask: no approval handler");
      return { block: true, reason };
    }

    let resolution: ApprovalResolution;
    try {
      resolution = await withAbort(options.approvalHandler(request), signal);
    } catch {
      appendApproval("cancelled", "handler threw or caller aborted");
      const reason = "[brainstem] approval cancelled";
      emitBlockedObservation(toolCallId, tool, args, reason, "approval cancelled");
      return { block: true, reason };
    }

    const currentHash = hashAction(
      actionIdentity(tool, args, { target: prepared.target, preconditionDigest: prepared.preconditionDigest }),
    );
    if (currentHash !== actionHash) {
      appendApproval("invalidated", "action changed since request");
      const reason = "[brainstem] approval cancelled";
      emitBlockedObservation(toolCallId, tool, args, reason, "action changed since approval request");
      return { block: true, reason };
    }

    if (resolution !== "approve_once") {
      appendApproval("denied", "denied by user");
      const reason = "[brainstem] denied by user";
      emitBlockedObservation(toolCallId, tool, args, reason, "denied by user");
      return { block: true, reason };
    }

    // Recheck target identity and preimage right before consuming approval:
    // a file edited (or a target substituted) between request and
    // resolution must re-enter review rather than silently execute against
    // whatever now sits at that path.
    if (prepared.recheck) {
      const check = prepared.recheck();
      if (check.changed) {
        appendApproval("invalidated", check.reason);
        const reason = `[brainstem] approval cancelled: ${check.reason}. Re-run for a fresh review.`;
        emitBlockedObservation(toolCallId, tool, args, reason, check.reason);
        return { block: true, reason };
      }
    }

    appendApproval("approved");
    return undefined;
  }

  const innerStreamFn = options.streamFn;
  let modelStartedAt = 0;
  let firstTokenAt: number | undefined;
  const routedStreamFn: StreamFn = async (model, context, streamOptions) => {
    modelStartedAt = performance.now();
    firstTokenAt = undefined;
    engine.noteModelCall();
    if (options.miniModel) {
      const latest = recorder.recentActivity(1)[0];
      const capabilities = activeCapabilityDescriptions();
      const decision = await timedJev(() =>
        engine.steer(
          {
            task: taskText(),
            events: summarizeMessages(context.messages),
            ...(latest !== undefined ? { latestObservation: latest } : {}),
            ...(capabilities.length > 0 ? { capabilities } : {}),
          },
          // The harness performs the routing, so it is the only place that knows
          // which model id a chosen tier actually resolves to.
          { resolveModelId: (tier) => (tier === "mini" ? options.miniModel!.id : model.id) },
        ),
      );
      options.onReflex?.(render("steer", decision.tier, decision.reasons));
      return innerStreamFn(decision.tier === "mini" ? options.miniModel : model, context, streamOptions);
    }
    return innerStreamFn(model, context, streamOptions);
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: options.model,
      tools: initialBuilt.tools,
      thinkingLevel: options.thinkingLevel ?? "low",
    },
    streamFn: routedStreamFn,
    toolExecution: "sequential",
    shouldStopAfterTurn: async () => {
      turnsCompleted += 1;
      const every = options.pulseEveryTurns ?? 3;
      if (turnsCompleted % every !== 0) return false;

      const decision = await timedJev(() =>
        engine.pulse({
          task: taskText(),
          events: summarizeMessages(agent.state.messages),
          budget: `${recorder.modelCalls} model calls so far`,
          facts: recorder.pulseFacts(),
          actionHashes: recorder.recentActionHashes.slice(-6),
        }),
      );
      options.onReflex?.(render("pulse", decision.action, decision.reasons));

      if (decision.action === "stop") return true;
      if (decision.action === "intervene") {
        agent.steer({
          role: "user",
          content: [
            {
              type: "text",
              text: `[brainstem] reflex intervention: ${decision.reasons.join("; ")}. Change your approach — do not simply repeat your previous steps.`,
            },
          ],
          timestamp: Date.now(),
        });
      }
      return false;
    },
    prepareNextTurnWithContext: async ({ context }) => {
      const currentTask = recorder.currentTask;
      const currentRevision = currentTask?.revision ?? 0;
      if (currentRevision !== lastTaskRevision) {
        await driver.refresh({ task: taskText(), recent: summarizeMessages(context.messages) }, { reason: "task_update" });
        lastTaskRevision = currentRevision;
      }

      const decision = driver.currentDecision();
      const ws = registry.workingSet({}, decision && { evaluated: decision.evaluated, recommended: decision.recommended });
      const built = buildActiveContext(registry, ws);
      const idsKey = built.activeIds.join(",");
      if (idsKey === appliedIdsKey && built.instructionHash === appliedInstructionHash) {
        return undefined;
      }

      journal.append({
        t: "capability_set",
        v: 2,
        ts: Date.now(),
        ...(currentTask ? { taskId: currentTask.id } : {}),
        ...(recorder.currentTurnId ? { turnId: recorder.currentTurnId } : {}),
        catalogHash: registry.catalogFingerprint(),
        activeIds: built.activeIds,
        ...(built.instructionHash !== undefined ? { instructionHash: built.instructionHash } : {}),
      });

      // Discovery-driven refresh happens inside a tool execute mid-turn and updates
      // the driver's decision immediately, but this single integration point is
      // where tool-set/skill-instruction changes reach the model — at the next
      // turn boundary after the current assistant turn's remaining tool calls finish.
      const result = {
        context: {
          messages:
            built.instructionHash !== appliedInstructionHash && built.instructionBlock !== undefined
              ? [...context.messages, { role: "system", content: built.instructionBlock, timestamp: Date.now() } as Message]
              : context.messages,
          tools: built.tools,
        },
      };

      agent.state.tools = built.tools;
      appliedIdsKey = idsKey;
      appliedInstructionHash = built.instructionHash;
      return result;
    },
    beforeToolCall: async ({ toolCall, args }, signal) => {
      const a = (args ?? {}) as { command?: string; path?: string };
      const toolCallId = toolCall.id;

      if (toolCall.name === "bash" || toolCall.name === "write") {
        let writeCheck: ReturnType<typeof checkWriteTarget> | undefined;
        if (toolCall.name === "write") {
          writeCheck = checkWriteTarget(options.cwd, a.path ?? "");
          // Reject a symlinked write route outright — authorization and
          // execution must refer to the same filesystem target, and a final
          // (or dangling) symlink means they cannot. This never reaches
          // Jev: rejection beats silently changing which file the write
          // affects.
          if (!writeCheck.ok) {
            const why = `blocked write: ${writeCheck.reason}`;
            journal.append({
              t: "decision",
              v: 2,
              ts: Date.now(),
              reflex: "gate",
              action: "deny",
              reasons: [why],
              staticVerdict: "deny",
            });
            options.onReflex?.(render("gate", "deny", [why]));
            const reason = `[brainstem] denied: ${why}. Do not retry this command.`;
            emitBlockedObservation(toolCallId, toolCall.name, args, reason, `gate deny: ${why}`);
            return { block: true, reason };
          }
        }

        // Computed once, right after the write target is verified, so
        // EVERY approval path below (outside-root static-floor ask, and the
        // normal Jev-decided ask) shows the same real diff/content summary
        // and binds to the same preimage — not just the path that happens
        // to reach Jev. A stale/missing prepared-action protection on one
        // branch was the R3 gap: identity/preimage checks must be uniform
        // across every way an approval can be requested.
        const change =
          toolCall.name === "write"
            ? changeSummaryForWrite(options.cwd, a.path ?? "", (args as { content?: string } | undefined)?.content ?? "")
            : undefined;
        const writeApprovalPrepared = (): {
          target: string;
          changeSummary?: string;
          preconditionDigest?: string;
          recheck: () => { changed: boolean; reason: string };
        } => {
          const target = writeCheck!.resolvedTarget;
          return {
            target,
            changeSummary: change?.changeSummary,
            preconditionDigest: change?.existingDigest,
            recheck: () => {
              const recheck = checkWriteTarget(options.cwd, a.path ?? "");
              if (!recheck.ok || recheck.resolvedTarget !== target) {
                return { changed: true, reason: "write target changed since approval was requested" };
              }
              let currentDigest: string;
              try {
                currentDigest = contentHash(readFileSync(target, "utf8"));
              } catch {
                currentDigest = ABSENT_DIGEST;
              }
              if (currentDigest !== (change?.existingDigest ?? ABSENT_DIGEST)) {
                return { changed: true, reason: "file contents changed since approval was requested" };
              }
              return { changed: false, reason: "" };
            },
          };
        };

        // For a write: sets writePreconditions[toolCallId] to the digest the
        // target's content was just verified to still match, immediately
        // before allowing execution — the ONE channel the write tool's own
        // execute() can read it back from (see tools.ts's ToolDeps doc
        // comment). Consumed once by the descriptor-relative executor,
        // binding the write's PREIMAGE through execution the same way its
        // TARGET is bound through execution.
        const runWriteApproval = async (
          reasons: string[],
        ): Promise<{ block: true; reason: string } | undefined> => {
          const result = await runApproval(toolCallId, toolCall.name, args, reasons, signal, writeApprovalPrepared());
          if (result === undefined) {
            writePreconditions.set(toolCallId, change?.existingDigest ?? ABSENT_DIGEST);
          }
          return result;
        };

        // Literal containment is decided in code, never by a judgment: a write whose
        // resolved target leaves the configured root takes the static floor verdict
        // and never reaches Jev.
        if (toolCall.name === "write" && !isInside(options.cwd, writeCheck!.resolvedTarget)) {
          const verdict = staticVerdict("write", { path: a.path }, options.cwd) ?? "ask";
          const why = `static floor: write outside project root (${a.path ?? "?"})`;
          journal.append({
            t: "decision",
            v: 2,
            ts: Date.now(),
            reflex: "gate",
            action: verdict,
            reasons: [why],
            staticVerdict: verdict,
          });
          options.onReflex?.(render("gate", verdict, [why]));
          if (verdict === "deny") {
            const reason = `[brainstem] denied: ${why}. Do not retry this command.`;
            emitBlockedObservation(toolCallId, toolCall.name, args, reason, `gate deny: ${why}`);
            return { block: true, reason };
          }
          return await runWriteApproval([why]);
        }

        const decision = await timedJev(() =>
          engine.gate({
            tool: toolCall.name,
            task: taskText(),
            ...(toolCall.name === "bash" ? { command: a.command ?? "" } : {}),
            ...(a.path !== undefined ? { path: a.path } : {}),
            ...(change !== undefined ? { changeSummary: change.changeSummary } : {}),
            ...(change?.evidenceIncomplete === true ? { evidenceIncomplete: true } : {}),
          }),
        );
        options.onReflex?.(render("gate", decision.action, decision.reasons));
        if (decision.action === "deny") {
          const reason = `[brainstem] denied: ${decision.reasons.join("; ")}. Do not retry this command.`;
          emitBlockedObservation(toolCallId, toolCall.name, args, reason, `gate deny: ${decision.reasons.join("; ")}`);
          return { block: true, reason };
        }
        if (decision.action === "ask") {
          if (toolCall.name === "write") return await runWriteApproval(decision.reasons);
          return await runApproval(toolCallId, toolCall.name, args, decision.reasons, signal, {});
        }

        // "auto": bind execution to the target/preimage captured above. Jev
        // evaluation is an await point — a write whose target or existing
        // content changed WHILE that call was in flight (e.g. a parent
        // directory swapped for a symlink mid-request, or the target file
        // edited) must not silently proceed just because the semantic
        // judgment came back favorable for the ORIGINAL target. This closes
        // the same class of gap R3's approval recheck closes for the "ask"
        // path, for the "auto" path, where nothing else re-verifies
        // anything between gate and execution. writePreconditions is set
        // here too — the write tool's execute() binds its own descriptor-
        // relative walk to the SAME preimage this recheck just confirmed,
        // not just to a recheck result that execute() can never see.
        if (toolCall.name === "write") {
          const recheck = writeApprovalPrepared().recheck();
          if (recheck.changed) {
            const why = `write target changed during gate evaluation: ${recheck.reason}`;
            journal.append({
              t: "decision",
              v: 2,
              ts: Date.now(),
              reflex: "gate",
              action: "deny",
              reasons: [why],
              staticVerdict: "deny",
            });
            options.onReflex?.(render("gate", "deny", [why]));
            const reason = `[brainstem] denied: ${why}. Re-run for a fresh review.`;
            emitBlockedObservation(toolCallId, toolCall.name, args, reason, `gate deny: ${why}`);
            return { block: true, reason };
          }
          writePreconditions.set(toolCallId, change?.existingDigest ?? ABSENT_DIGEST);
        }
        return undefined;
      }

      if (toolCall.name === "read" || toolCall.name === "grep" || toolCall.name === "glob") {
        const verdict = staticVerdict(toolCall.name, { path: a.path }, options.cwd);
        if (verdict !== null) {
          journal.append({
            t: "decision",
            v: 2,
            ts: Date.now(),
            reflex: "gate",
            action: verdict,
            reasons: [`static floor: secrets path ${a.path}`],
            staticVerdict: verdict,
          });
          options.onReflex?.(render("gate", verdict, [`secrets path ${a.path}`]));
          const reason = gateBlock(`reading or searching ${a.path} touches potential secrets`).reason;
          emitBlockedObservation(toolCallId, toolCall.name, args, reason, `static floor: secrets path ${a.path}`);
          return { block: true, reason };
        }
      }

      return undefined;
    },
    afterToolCall: async ({ toolCall, result, isError }) => {
      const toolCallId = toolCall.id;
      const rawContent = (result?.content ?? []) as { type: string; text?: string }[];
      const fullText = textOf(rawContent);
      const nonTextCount = rawContent.filter((c) => c.type !== "text").length;
      const details = detailsOf(result);

      // Capture the full output before any sanitize override so the original
      // bytes stay recoverable even when the presented view is blocked or
      // bounded. Captured regardless of isError: untrusted failure text (a
      // stderr tail, an exception message) needs the same review and
      // recovery path as any other tool output — R1's whole point is that
      // isError must never be a bypass. Preserved as separate named streams
      // (R5): bash keeps stdout/stderr distinct rather than implying their
      // concatenation reconstructs temporal interleaving; every other
      // captured tool has exactly one "output" stream. Empty output is still
      // captured as an empty artifact — "(no output)" is presentation
      // wording, applied below, never source content.
      let artifact: ArtifactRecord | undefined;
      if (CAPTURED_TOOLS.has(toolCall.name) && !RECOVERY_TOOLS.has(toolCall.name)) {
        const args = (toolCall.arguments ?? {}) as { command?: string; path?: string; pattern?: string };
        const streamContent: Record<string, string> = {};
        const streams: Record<string, { bytesObserved: number; bytesRetained: number; complete: boolean }> = {};
        if (toolCall.name === "bash" && details.stdoutText !== undefined) {
          streamContent.stdout = details.stdoutText;
          streamContent.stderr = details.stderrText ?? "";
          streams.stdout = {
            bytesObserved: details.stdoutObservedBytes ?? Buffer.byteLength(streamContent.stdout, "utf8"),
            bytesRetained: Buffer.byteLength(streamContent.stdout, "utf8"),
            complete: details.stdoutComplete !== false,
          };
          streams.stderr = {
            bytesObserved: details.stderrObservedBytes ?? Buffer.byteLength(streamContent.stderr, "utf8"),
            bytesRetained: Buffer.byteLength(streamContent.stderr, "utf8"),
            complete: details.stderrComplete !== false,
          };
        } else {
          streamContent.output = fullText;
          streams.output = {
            bytesObserved: details.sourceBytes ?? Buffer.byteLength(fullText, "utf8"),
            bytesRetained: Buffer.byteLength(fullText, "utf8"),
            complete: details.truncated !== true,
          };
        }
        const record: ArtifactRecord = {
          artifactId: newId("art"),
          sessionId: recorder.sessionId,
          schemaVersion: ARTIFACT_SCHEMA_VERSION,
          toolCallId,
          tool: toolCall.name,
          commandOrTarget: args.command ?? args.path ?? args.pattern ?? "",
          // Documented rendering order for the combined hash: stream
          // insertion order above (stdout before stderr for bash), matching
          // `fullText`'s own construction in tools.ts — never implied as the
          // true temporal interleaving.
          contentHash: contentHash(fullText),
          byteCount: Object.values(streams).reduce((sum, s) => sum + s.bytesRetained, 0),
          lineCount: countLines(fullText),
          captureComplete: Object.values(streams).every((s) => s.complete),
          createdAt: Date.now(),
          streams,
        };
        artifactStore.put(record, streamContent);
        artifact = record;
      }

      const obs: ToolObservation = {
        toolCallId,
        tool: toolCall.name,
        argsSummary: argsSummaryFor(toolCall.arguments),
        status: isError ? "error" : (details.status ?? "ok"),
        ...(details.exit !== undefined ? { exitCode: details.exit } : {}),
        durationMs: details.durationMs ?? 0,
        // This excerpt is internal bookkeeping only (journal + recent-activity
        // summaries for Pulse/Steer) — it must never be reused as a
        // presentation bound for what's actually delivered to the model.
        excerpt: fullText.slice(0, EXCERPT_CAP),
        truncated: details.truncated ?? fullText.length > EXCERPT_CAP,
      };
      recorder.recordAction(hashAction({ tool: obs.tool, args: obs.argsSummary }), actionLabel(obs.tool, obs.argsSummary));

      // Shared by both Focus and sanitize/verify below — one bounded intent
      // string, not two independently-phrased ones.
      const intent = `${toolCall.name} ${JSON.stringify(toolCall.arguments)}`;

      let manifest: SectionManifest | undefined;
      let focusDecision: FocusDecision | undefined;
      const focusRollout: FocusRolloutMode = options.focusMode ?? "off";
      if (artifact && focusRollout !== "off") {
        manifest = splitIntoSections(artifact.artifactId, fullText);
        focusDecision = await timedJev(() =>
          engine.focus({
            task: taskText(),
            command: actionLabel(toolCall.name, toolCall.arguments),
            intent,
            outcome: obs.status,
            recentFindings: recorder.recentActivity(5),
            manifest: manifest!,
            budgetChars: FOCUS_PRESENT_BUDGET_CHARS,
          }),
        );
        options.onReflex?.(render("focus", focusDecision.mode, focusDecision.reasons));
      }

      // The single presentation boundary: an artifact-backed result goes
      // through presentArtifact's line+char bounding; anything else (a write
      // confirmation, a recovery-tool page, a discovery result) is expected
      // to already be a complete, self-bounded view, but boundForReview is
      // still applied as a backstop so nothing downstream can ever exceed
      // the same cap Sanitize reviews.
      const view = artifact
        ? presentArtifact(fullText, artifact.artifactId, {
            // "shadow" computes and journals the decision above but never shapes
            // what is shown — only "on" does. This is the one place that
            // distinction is enforced.
            rollout: focusRollout === "on" ? "on" : "off",
            manifest,
            decision: focusDecision,
          })
        : boundForReview(fullText, REVIEW_CHAR_CAP);

      let baseView = view.text;
      let deliveredTruncated = view.truncated;
      let deliveredWhy: string | undefined;

      let deliveredExcerpt = baseView;

      if (fullText.trim()) {
        const observed = await timedJev(() =>
          engine.observeToolResult({
            task: taskText(),
            source: `tool:${toolCall.name}`,
            actionSummary: intent,
            intent,
            status: obs.status,
            truncated: deliveredTruncated,
            // The exact bounded view the model will see, never a second
            // independent slice of the raw capture — sanitize must not judge
            // content the agent was never shown. baseView is already bounded
            // by the presentation boundary above, so no further slicing here.
            content: baseView,
          }),
        );
        options.onReflex?.(render("sanitize", observed.sanitize.action, observed.sanitize.reasons));
        if (observed.verify.action === "mismatch") {
          options.onReflex?.(render("verify", observed.verify.action, observed.verify.reasons));
        } else if (!observed.verify.verified) {
          options.onReflex?.(render("verify", "unavailable", observed.verify.reasons));
        }

        if (observed.sanitize.action === "block") {
          // A fixed, harness-authored control message — never tool-supplied
          // text — regardless of whether the blocked result was an error.
          deliveredExcerpt = `[brainstem] blocked tool output (probable injected instructions): ${observed.sanitize.reasons.join("; ")}`;
          deliveredTruncated = false;
          deliveredWhy = `sanitize blocked output: ${observed.sanitize.reasons.join("; ")}`;
        } else {
          const notes: string[] = [];
          if (observed.sanitize.action === "review") {
            notes.push(`[brainstem] review this content: ${observed.sanitize.reasons.join("; ")}`);
            deliveredWhy = "sanitize review notes prepended";
          }
          if (observed.verify.action === "mismatch") {
            notes.push(
              `[brainstem] verify: this output may not satisfy what the tool call was trying to do (${observed.verify.reasons.join("; ")}). Consider a different approach if progress stalls.`,
            );
            deliveredWhy ??= "verify notes prepended";
          } else if (!observed.verify.verified) {
            notes.push("[brainstem] verify: unavailable — result not verified");
            deliveredWhy ??= "verify unavailable notes prepended";
          }
          if (notes.length > 0) {
            deliveredExcerpt = `${notes.join("\n")}\n\n${baseView}`;
          }
        }
      }

      // Non-text content is never reviewed by Sanitize/Verify (they only see
      // `fullText`), so it is always withheld rather than labeling a mixed
      // result "reviewed" because only its text part passed.
      if (nonTextCount > 0) {
        const notice = `[brainstem] ${nonTextCount} non-text content part(s) withheld: unreviewed content types are never delivered.`;
        deliveredExcerpt = fullText.trim() ? `${deliveredExcerpt}\n\n${notice}` : notice;
        deliveredWhy ??= "non-text content withheld";
      }

      // "(no output)" is presentation wording only — the artifact above (if
      // any) already stored the true, possibly-empty capture. Substituted
      // here, at delivery time, never baked into a tool's own returned text.
      if (!isError && nonTextCount === 0 && deliveredExcerpt.length === 0) {
        deliveredExcerpt = "(no output)";
      }

      if (artifact) {
        journal.append({
          t: "artifacts",
          v: 2,
          artifactId: artifact.artifactId,
          ts: Date.now(),
          toolCallId,
          contentHash: artifact.contentHash,
          captureComplete: artifact.captureComplete,
          byteCount: artifact.byteCount,
          presentedViewHash: contentHash(deliveredExcerpt),
          ...(manifest !== undefined ? { sectionManifestHash: manifest.catalogHash } : {}),
          ...(focusDecision !== undefined
            ? {
                focusRollout: (focusRollout === "on" ? "on" : "shadow") as "on" | "shadow",
                focusMode: focusDecision.mode,
                focusStatus: focusDecision.status,
              }
            : {}),
        });
      }

      emitObservation(obs, deliveredExcerpt, deliveredTruncated, deliveredWhy);

      if (deliveredExcerpt !== fullText || nonTextCount > 0) {
        // isError is intentionally omitted here: the framework preserves the
        // original error flag unless explicitly overridden, and content
        // review must never itself flip an ok result into an error or vice
        // versa.
        return { content: [{ type: "text", text: deliveredExcerpt }] };
      }
      return undefined;
    },
  });

  agent.subscribe((event) => {
    if (event.type === "message_end") {
      const message = event.message as {
        role: string;
        content: { type: string; text?: string }[];
        model?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
      };
      if (message.role === "assistant") {
        if (modelStartedAt > 0) turnModelMs += performance.now() - modelStartedAt;
        const usage = message.usage;
        const cost = usage?.cost?.total;
        const costTotal: number | "unknown" = typeof cost === "number" && cost > 0 ? cost : "unknown";
        recorder.recordModelCall();
        recorder.recordCost(costTotal);
        journal.append({
          t: "llm_call",
          v: 2,
          turnId: recorder.currentTurnId ?? "",
          ts: Date.now(),
          model: message.model ?? "unknown",
          durationMs: Math.round(performance.now() - modelStartedAt),
          usage: {
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            cacheRead: usage?.cacheRead ?? 0,
            cacheWrite: usage?.cacheWrite ?? 0,
            costTotal,
          },
          ...(firstTokenAt !== undefined ? { firstTokenMs: Math.round(firstTokenAt) } : {}),
        });
      }
    } else if (event.type === "message_update") {
      const update = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (update?.type === "text_delta" && update.delta) {
        if (firstTokenAt === undefined && modelStartedAt > 0) firstTokenAt = performance.now() - modelStartedAt;
        options.onDelta?.(update.delta);
      }
    }
  });

  return {
    agent,
    engine,
    journal,
    recorder,
    journalPath: options.journalPath,
    approvalsRequested: () => approvalsRequestedCount,
    async prompt(text: string) {
      recorder.startTask(text);
      turnJevMs = 0;
      turnModelMs = 0;
      recorder.beginTurn();
      try {
        // Initial capability selection for this task. Done here rather than before
        // Agent construction because the objective is only known at prompt time.
        const initialDecision = await driver.refresh({ task: taskText(), recent: [] }, { reason: "initial" });
        const refreshedWs = registry.workingSet(
          {},
          initialDecision && { evaluated: initialDecision.evaluated, recommended: initialDecision.recommended },
        );
        const refreshedBuilt = buildActiveContext(registry, refreshedWs);
        agent.state.tools = refreshedBuilt.tools;
        if (refreshedBuilt.instructionBlock !== undefined) {
          const skillMessage: Message = { role: "system", content: refreshedBuilt.instructionBlock, timestamp: Date.now() };
          agent.state.messages = [...agent.state.messages, skillMessage];
        }
        appliedIdsKey = refreshedBuilt.activeIds.join(",");
        appliedInstructionHash = refreshedBuilt.instructionHash;
        lastTaskRevision = recorder.currentTask?.revision ?? 0;

        await agent.prompt(text);
      } finally {
        const spans: TurnSpans = {};
        if (turnJevMs > 0) spans.jevMs = Math.round(turnJevMs);
        if (turnModelMs > 0) spans.modelMs = Math.round(turnModelMs);
        recorder.endTurn(Object.keys(spans).length > 0 ? spans : undefined);
      }
    },
    endSession(reason: "normal" | "error" = "normal", error?: string) {
      recorder.endSession(reason, error);
    },
  };
}

type AgentEventLike = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: { role: string; content: { type: string; text?: string }[]; model?: string; usage?: { cost?: { total?: number } } };
  assistantMessageEvent?: { type: string; delta?: string };
};
