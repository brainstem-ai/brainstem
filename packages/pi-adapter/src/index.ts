import type { Agent } from "@earendil-works/pi-agent-core";
import type { Reflexes } from "@brainstem/reflexes";

const DEFAULT_CAPTURED_TOOLS = new Set(["bash", "read", "write", "grep", "glob"]);

export interface AttachReflexesOptions {
  /** Required — Gate's static floor and Focus both need a real root. */
  cwd: string;
  /** Default: bash, read, write, grep, glob — matches packages/cli's own CAPTURED_TOOLS. */
  capturedTools?: Set<string>;
  taskText?: () => string;
  recentActivity?: () => string[];
  /**
   * Default "off". "on" means Focus's selected view is the ONLY thing the
   * model sees, permanently — this package has no artifact store and no
   * read_output/search_output recovery tools, unlike the full CLI harness
   * (F0). Content Focus omits here cannot be recovered later. Use "off"
   * unless you have your own recovery path, or adopt the full CLI harness.
   */
  focusMode?: "off" | "on";
  onReflex?: (line: string) => void;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/**
 * Attaches Gate, Sanitize, Verify, and (optionally) Focus to an existing Pi
 * Agent by composing with whatever beforeToolCall/afterToolCall it already
 * has — never replacing them. Calling this twice on the same agent composes
 * twice; that is correct (if wasteful) behavior, not a bug this package
 * guards against.
 *
 * No approval lifecycle is implemented: a Gate "ask" verdict is blocked with
 * a clear reason. A consumer wanting real interactive approval should use
 * reflexes.gate()'s "ask" outcome directly, or adopt the full CLI harness
 * (packages/cli), which implements the full approval lifecycle.
 */
export function attachReflexes(agent: Agent, reflexes: Reflexes, options: AttachReflexesOptions): void {
  const capturedTools = options.capturedTools ?? DEFAULT_CAPTURED_TOOLS;
  const taskText = () => options.taskText?.() ?? "unspecified";

  const originalBefore = agent.beforeToolCall;
  agent.beforeToolCall = async (context, signal) => {
    const originalResult = await originalBefore?.(context, signal);
    if (originalResult?.block) return originalResult; // respect an existing block; never spend a judge call on a call already refused

    if (!capturedTools.has(context.toolCall.name)) return originalResult;

    const args = (context.args ?? {}) as { command?: string; path?: string };
    const decision = await reflexes.gate({
      tool: context.toolCall.name,
      command: context.toolCall.name === "bash" ? args.command : undefined,
      path: args.path,
      task: taskText(),
    });
    options.onReflex?.(`[gate] ${decision.action}${decision.reasons[0] ? ` — ${decision.reasons[0]}` : ""}`);

    if (decision.action === "deny") {
      return { block: true, reason: `[brainstem] denied: ${decision.reasons.join("; ")}` };
    }
    if (decision.action === "ask") {
      return {
        block: true,
        reason: `[brainstem] needs approval: ${decision.reasons.join("; ")} (this adapter does not implement interactive approval — see @brainstem/pi-adapter's docs, or use reflexes.gate() directly to build your own)`,
      };
    }
    return originalResult;
  };

  const originalAfter = agent.afterToolCall;
  agent.afterToolCall = async (context, signal) => {
    const originalResult = await originalAfter?.(context, signal);
    if (!capturedTools.has(context.toolCall.name)) return originalResult;

    const isError = originalResult?.isError ?? context.isError;
    if (isError) return originalResult;

    // The original hook's own transformation, if any, is what we judge — its
    // output is what the model would actually see, not the pre-override raw
    // result.
    const effectiveContent = (originalResult?.content ?? context.result.content) as { type: string; text?: string }[];
    const text = textOf(effectiveContent);
    if (!text.trim()) return originalResult;

    const observed = await reflexes.observe({
      task: taskText(),
      source: `tool:${context.toolCall.name}`,
      actionSummary: `${context.toolCall.name} ${JSON.stringify(context.args)}`.slice(0, 300),
      status: "ok",
      truncated: false,
      content: text.slice(0, 8000),
    });
    options.onReflex?.(`[sanitize] ${observed.sanitize.action}`);
    if (observed.verify.action === "mismatch") {
      options.onReflex?.(`[verify] mismatch — ${observed.verify.reasons.join("; ")}`);
    }

    let finalText = text;
    if (observed.sanitize.action === "block") {
      finalText = `[brainstem] blocked tool output (probable injected instructions): ${observed.sanitize.reasons.join("; ")}`;
    } else if (options.focusMode === "on") {
      const focused = await reflexes.focus({
        task: taskText(),
        command: context.toolCall.name,
        outcome: "ok",
        recentFindings: options.recentActivity?.() ?? [],
        content: text,
      });
      finalText = focused.text;
    }

    if (finalText === text) return originalResult;
    return { ...originalResult, content: [{ type: "text", text: finalText }] };
  };
}
