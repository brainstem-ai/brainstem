import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
  ReflexEngine,
  toIds,
  hashAction,
  newId,
  openJournal,
  policyForTrust,
  staticVerdict,
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalStatus,
  type Journal,
  type SystemOne,
  type ToolObservation,
  type ToolStatus,
  type TurnSpans,
} from "@brainstem/core";
import { CapabilityRegistry } from "./capabilities/registry";
import { changeSummaryForWrite } from "./change-summary";
import { isInside, resolveParentForWrite } from "./paths";
import { SessionRecorder } from "./session";
import { makeTools } from "./tools";

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
  });

  const taskText = () => recorder.currentTask?.objective ?? "unspecified";

  const render = (reflex: string, action: string, reasons: string[]) =>
    `[${reflex}] ${action}${reasons.length > 0 ? ` — ${reasons[0]}` : ""}`;

  function gateBlock(reason: string): { block: true; reason: string } {
    return { block: true, reason: `[brainstem] ${reason} Ask the user to confirm, and re-run only if they approve.` };
  }

  const tools: AgentTool[] = makeTools({ cwd: options.cwd });
  const registry = options.registry ?? new CapabilityRegistry();

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
    recorder.recordAction(hashAction({ tool, args: argsSummaryFor(args) }), actionLabel(tool, args));
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

  async function runApproval(
    toolCallId: string,
    tool: string,
    args: unknown,
    reasons: string[],
    signal: AbortSignal | undefined,
  ): Promise<{ block: true; reason: string } | undefined> {
    // Approval binds to the validated args of this beforeToolCall invocation: args
    // are fixed within one hook call, so the hash recorded at request time is
    // re-checked at resolution time against those same validated inputs.
    const approvalId = newId("appr");
    const taskId = recorder.currentTask?.id ?? "";
    const actionHash = hashAction({ tool, args: argsSummaryFor(args) });
    const request: ApprovalRequest = {
      id: approvalId,
      taskId,
      toolCallId,
      cwd: options.cwd,
      tool,
      validatedArgs: args ?? {},
      actionHash,
      reasons,
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

    if (hashAction({ tool, args: argsSummaryFor(args) }) !== actionHash) {
      appendApproval("invalidated", "action changed since request");
      const reason = "[brainstem] approval cancelled";
      emitBlockedObservation(toolCallId, tool, args, reason, "action changed since approval request");
      return { block: true, reason };
    }

    if (resolution === "approve_once") {
      appendApproval("approved");
      return undefined;
    }

    appendApproval("denied", "denied by user");
    const reason = "[brainstem] denied by user";
    emitBlockedObservation(toolCallId, tool, args, reason, "denied by user");
    return { block: true, reason };
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
      tools,
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
    beforeToolCall: async ({ toolCall, args }, signal) => {
      const a = (args ?? {}) as { command?: string; path?: string };
      const toolCallId = toolCall.id;

      if (toolCall.name === "bash" || toolCall.name === "write") {
        // Literal containment is decided in code, never by a judgment: a write whose
        // resolved target leaves the configured root takes the static floor verdict
        // and never reaches Jev.
        if (toolCall.name === "write" && !isInside(options.cwd, resolveParentForWrite(options.cwd, a.path ?? ""))) {
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
          return await runApproval(toolCallId, toolCall.name, args, [why], signal);
        }

        const change =
          toolCall.name === "write"
            ? changeSummaryForWrite(options.cwd, a.path ?? "", (args as { content?: string } | undefined)?.content ?? "")
            : undefined;
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
          return await runApproval(toolCallId, toolCall.name, args, decision.reasons, signal);
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
      const fullText = textOf((result?.content ?? []) as { type: string; text?: string }[]);
      const details = detailsOf(result);

      const obs: ToolObservation = {
        toolCallId,
        tool: toolCall.name,
        argsSummary: argsSummaryFor(toolCall.arguments),
        status: isError ? "error" : (details.status ?? "ok"),
        ...(details.exit !== undefined ? { exitCode: details.exit } : {}),
        durationMs: details.durationMs ?? 0,
        excerpt: fullText.slice(0, EXCERPT_CAP),
        truncated: details.truncated ?? fullText.length > EXCERPT_CAP,
      };
      recorder.recordAction(hashAction({ tool: obs.tool, args: obs.argsSummary }), actionLabel(obs.tool, obs.argsSummary));

      let deliveredExcerpt = obs.excerpt;
      let deliveredTruncated = obs.truncated;
      let deliveredWhy: string | undefined;

      if (!isError && fullText.trim()) {
        const intent = `${toolCall.name} ${JSON.stringify(toolCall.arguments)}`;
        const observed = await timedJev(() =>
          engine.observeToolResult({
            task: taskText(),
            source: `tool:${toolCall.name}`,
            actionSummary: intent,
            intent,
            status: obs.status,
            truncated: obs.truncated,
            content: fullText.slice(0, 8000),
          }),
        );
        options.onReflex?.(render("sanitize", observed.sanitize.action, observed.sanitize.reasons));
        if (observed.verify.action === "mismatch") {
          options.onReflex?.(render("verify", observed.verify.action, observed.verify.reasons));
        } else if (!observed.verify.verified) {
          options.onReflex?.(render("verify", "unavailable", observed.verify.reasons));
        }

        if (observed.sanitize.action === "block") {
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
            deliveredExcerpt = `${notes.join("\n")}\n\n${obs.excerpt}`;
          }
        }
      }

      emitObservation(obs, deliveredExcerpt, deliveredTruncated, deliveredWhy);

      if (isError) return undefined;
      if (!fullText.trim()) return undefined;
      if (deliveredExcerpt !== obs.excerpt) {
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
