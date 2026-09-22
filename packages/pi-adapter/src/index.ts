import type { Agent } from "@earendil-works/pi-agent-core";
import { boundForReview, REVIEW_CHAR_CAP, type Reflexes } from "@brainstem/reflexes";

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
 *
 * Filesystem contract limitation (R2): this package gates and sanitizes
 * whatever tools the CONSUMER supplies — it does not execute writes itself
 * and has no equivalent of packages/cli's symlink-rejecting, atomic
 * write-verification path (packages/cli/src/paths.ts). Wrapping a
 * consumer-supplied write tool's beforeToolCall/afterToolCall hooks is a
 * preflight check on the ARGUMENTS Gate was shown, not an enforcement of how
 * that tool's own execute() actually opens the file — it cannot detect or
 * prevent that tool resolving a symlinked or substituted target after Gate
 * approved it. A consumer wanting that guarantee must either give their tool
 * an equivalent verified-write implementation or adopt the full CLI harness.
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

    // Reviewed regardless of isError: a thrown tool error's message is
    // untrusted text too (e.g. a path or embedded fragment reflected back by
    // the runtime), and R1 requires it never bypass Sanitize/Verify.
    const isError = originalResult?.isError ?? context.isError;

    // The original hook's own transformation, if any, is what we judge — its
    // output is what the model would actually see, not the pre-override raw
    // result.
    const effectiveContent = (originalResult?.content ?? context.result.content) as { type: string; text?: string }[];
    const nonTextCount = effectiveContent.filter((c) => c.type !== "text").length;
    const text = textOf(effectiveContent);
    if (!text.trim() && nonTextCount === 0) return originalResult;

    // Single presentation boundary: bound BEFORE review, so Sanitize/Verify
    // see exactly what can ever be delivered — never a longer, independently
    // re-sliced version introduced later (e.g. by Focus).
    const bounded: BoundedTextLike = text.trim() ? boundForReview(text, REVIEW_CHAR_CAP) : { text: "", truncated: false, shownChars: 0, totalChars: 0 };

    let finalText = bounded.text;
    if (text.trim()) {
      const observed = await reflexes.observe({
        task: taskText(),
        source: `tool:${context.toolCall.name}`,
        actionSummary: `${context.toolCall.name} ${JSON.stringify(context.args)}`.slice(0, 300),
        status: isError ? "error" : "ok",
        truncated: bounded.truncated,
        content: bounded.text,
      });
      options.onReflex?.(`[sanitize] ${observed.sanitize.action}`);
      if (observed.verify.action === "mismatch") {
        options.onReflex?.(`[verify] mismatch — ${observed.verify.reasons.join("; ")}`);
      }

      if (observed.sanitize.action === "block") {
        finalText = `[brainstem] blocked tool output (probable injected instructions): ${observed.sanitize.reasons.join("; ")}`;
      } else if (options.focusMode === "on") {
        // Focus operates on the SAME bounded text Sanitize reviewed — never
        // on the unbounded raw capture, which would reintroduce unreviewed
        // content through selection. This package has no artifact store, so
        // Focus here can only select within the already-bounded view.
        const focused = await reflexes.focus({
          task: taskText(),
          command: context.toolCall.name,
          outcome: isError ? "error" : "ok",
          recentFindings: options.recentActivity?.() ?? [],
          content: bounded.text,
        });
        finalText = focused.text;
      } else if (bounded.truncated) {
        finalText = `${bounded.text}\n[brainstem] output bounded to ${bounded.shownChars} of ${bounded.totalChars} characters; this lightweight adapter has no recovery tool for the rest — see @brainstem/pi-adapter's docs, or use the full CLI harness (packages/cli) for pagination.`;
      }
    }

    if (nonTextCount > 0) {
      const notice = `[brainstem] ${nonTextCount} non-text content part(s) withheld: unreviewed content types are never delivered.`;
      finalText = finalText ? `${finalText}\n\n${notice}` : notice;
    }

    if (finalText === text && nonTextCount === 0) return originalResult;
    return { ...originalResult, content: [{ type: "text", text: finalText }] };
  };
}

interface BoundedTextLike {
  text: string;
  truncated: boolean;
  shownChars: number;
  totalChars: number;
}
