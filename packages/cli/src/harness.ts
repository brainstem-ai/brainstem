import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
  ReflexEngine,
  openJournal,
  policyForTrust,
  staticVerdict,
  type Journal,
  type JournalEvent,
  type SystemOne,
} from "@brainstem/core";
import { makeTools } from "./tools";

export const DEFAULT_SYSTEM_PROMPT = `You are a careful coding agent. Work inside the project directory. Prefer small, verifiable steps: run tests, read before writing, and keep the user informed. If a tool result says the harness blocked or flagged something, surface that to the user in your reply.`;

export interface HarnessOptions {
  systemOne: SystemOne;
  streamFn: StreamFn;
  model: Model<Api>;
  trust: number;
  journalPath: string;
  cwd: string;
  systemPrompt?: string;
  onReflex?: (line: string) => void;
  onDelta?: (delta: string) => void;
}

export interface Harness {
  agent: Agent;
  engine: ReflexEngine;
  journal: Journal;
  journalPath: string;
  prompt(text: string): Promise<void>;
}

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function summary(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] } | undefined;
  const text = r?.content ? textOf(r.content) : "";
  return text.slice(0, 200).replace(/\n/g, " ");
}

export function createHarness(options: HarnessOptions): Harness {
  const policy = policyForTrust(options.trust);
  const journal = openJournal(options.journalPath);
  journal.append({ t: "session_start", ts: Date.now(), trust: options.trust });

  const engine = new ReflexEngine({
    systemOne: options.systemOne,
    journal,
    policy,
    environment: `Working directory: ${options.cwd}. A git repository with a Node.js/TypeScript toolchain. A local Postgres dev database may be running.`,
  });

  let task = "unspecified";

  const render = (reflex: string, action: string, reasons: string[]) =>
    `[${reflex}] ${action}${reasons.length > 0 ? ` — ${reasons[0]}` : ""}`;

  function gateBlock(reason: string): { block: true; reason: string } {
    return { block: true, reason: `[brainstem] ${reason} Ask the user to confirm, and re-run only if they approve.` };
  }

  const tools: AgentTool[] = makeTools({ cwd: options.cwd });

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: options.model,
      tools,
    },
    streamFn: options.streamFn,
    beforeToolCall: async ({ toolCall, args }) => {
      const a = (args ?? {}) as { command?: string; path?: string };

      if (toolCall.name === "bash" || toolCall.name === "write") {
        const decision = await engine.gate({
          tool: toolCall.name,
          command: toolCall.name === "write" ? `write file ${a.path ?? "?"}` : (a.command ?? ""),
          task,
          path: a.path,
        });
        options.onReflex?.(render("gate", decision.action, decision.reasons));
        if (decision.action === "deny") {
          return { block: true, reason: `[brainstem] denied: ${decision.reasons.join("; ")}. Do not retry this command.` };
        }
        if (decision.action === "ask") {
          return gateBlock(`needs approval: ${decision.reasons.join("; ")}`);
        }
        return undefined;
      }

      if (toolCall.name === "read" || toolCall.name === "grep" || toolCall.name === "glob") {
        const verdict = staticVerdict(toolCall.name, { path: a.path });
        if (verdict !== null) {
          journal.append({
            t: "decision",
            ts: Date.now(),
            reflex: "gate",
            action: verdict,
            reasons: [`static floor: secrets path ${a.path}`],
          });
          options.onReflex?.(render("gate", verdict, [`secrets path ${a.path}`]));
          return gateBlock(`reading or searching ${a.path} touches potential secrets`);
        }
      }

      return undefined;
    },
    afterToolCall: async ({ toolCall, result, isError }) => {
      if (isError) return undefined;
      const text = textOf((result?.content ?? []) as { type: string; text?: string }[]);
      if (!text.trim()) return undefined;

      const decision = await engine.sanitize(text.slice(0, 8000), `tool:${toolCall.name}`);
      options.onReflex?.(render("sanitize", decision.action, decision.reasons));

      if (decision.action === "block") {
        return {
          content: [
            {
              type: "text",
              text: `[brainstem] blocked tool output (probable injected instructions): ${decision.reasons.join("; ")}`,
            },
          ],
        };
      }
      if (decision.action === "review") {
        return {
          content: [
            {
              type: "text",
              text: `[brainstem] review this content: ${decision.reasons.join("; ")}\n\n${text}`,
            },
          ],
        };
      }
      return undefined;
    },
  });

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      journal.append({
        t: "tool_call",
        ts: Date.now(),
        tool: event.toolName as string,
        args: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      journal.append({
        t: "tool_result",
        ts: Date.now(),
        tool: event.toolName as string,
        ok: !(event.isError as boolean),
        summary: summary(event.result),
      });
    } else if (event.type === "message_end") {
      const message = event.message as { role: string; content: { type: string; text?: string }[]; model?: string; usage?: { cost?: { total?: number } } };
      if (message.role === "assistant") {
        journal.append({
          t: "assistant_message",
          ts: Date.now(),
          text: textOf(message.content).slice(0, 2000),
          model: message.model ?? "unknown",
          costUsd: message.usage?.cost?.total ?? 0,
        });
      }
    } else if (event.type === "message_update") {
      const update = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (update?.type === "text_delta" && update.delta) options.onDelta?.(update.delta);
    }
  });

  return {
    agent,
    engine,
    journal,
    journalPath: options.journalPath,
    async prompt(text: string) {
      task = text;
      journal.append({ t: "user_message", ts: Date.now(), text });
      await agent.prompt(text);
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
