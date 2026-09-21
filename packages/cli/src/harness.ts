import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
  ReflexEngine,
  hashAction,
  newId,
  openJournal,
  policyForTrust,
  staticVerdict,
  type Journal,
  type SystemOne,
  type ToolObservation,
  type ToolStatus,
  type TurnSpans,
} from "@brainstem/core";
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
  prompt(text: string): Promise<void>;
  endSession(reason?: "normal" | "error", error?: string): void;
}

const EXCERPT_CAP = 2_000;

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

function argsSummaryFor(args: unknown): unknown {
  if (args === null || typeof args !== "object") return args ?? {};
  const { content: _content, ...rest } = args as Record<string, unknown>;
  return rest;
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

  function textOfAny(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return textOf(content as { type: string; text?: string }[]);
  }

  let turnsCompleted = 0;
  let turnJevMs = 0;
  let turnModelMs = 0;

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
    recorder.recordAction(hashAction({ tool, args: argsSummaryFor(args) }));
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

  const innerStreamFn = options.streamFn;
  let modelStartedAt = 0;
  let firstTokenAt: number | undefined;
  const routedStreamFn: StreamFn = async (model, context, streamOptions) => {
    modelStartedAt = performance.now();
    firstTokenAt = undefined;
    engine.noteModelCall();
    if (options.miniModel) {
      const decision = await timedJev(() =>
        engine.steer({ task: taskText(), events: summarizeMessages(context.messages) }),
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
    beforeToolCall: async ({ toolCall, args }) => {
      const a = (args ?? {}) as { command?: string; path?: string };
      const toolCallId = toolCall.id;

      if (toolCall.name === "bash" || toolCall.name === "write") {
        const decision = await timedJev(() =>
          engine.gate({
            tool: toolCall.name,
            command: toolCall.name === "write" ? `write file ${a.path ?? "?"}` : (a.command ?? ""),
            task: taskText(),
            path: a.path,
          }),
        );
        options.onReflex?.(render("gate", decision.action, decision.reasons));
        if (decision.action === "deny" || decision.action === "ask") {
          const reason =
            decision.action === "deny"
              ? `[brainstem] denied: ${decision.reasons.join("; ")}. Do not retry this command.`
              : gateBlock(`needs approval: ${decision.reasons.join("; ")}`).reason;
          emitBlockedObservation(toolCallId, toolCall.name, args, reason, `gate ${decision.action}: ${decision.reasons.join("; ")}`);
          return { block: true, reason };
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
      recorder.recordAction(hashAction({ tool: obs.tool, args: obs.argsSummary }));

      let deliveredExcerpt = obs.excerpt;
      let deliveredTruncated = obs.truncated;
      let deliveredWhy: string | undefined;

      if (!isError && fullText.trim()) {
        const intent = `${toolCall.name} ${JSON.stringify(toolCall.arguments)}`;
        const observed = await timedJev(() =>
          engine.observeToolResult(fullText.slice(0, 8000), `tool:${toolCall.name}`, intent),
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
    async prompt(text: string) {
      if (recorder.currentTask?.objective !== text) recorder.startTask(text);
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
