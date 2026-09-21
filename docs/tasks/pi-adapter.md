# Task: @brainstem/pi-adapter — attach reflexes to any Pi Agent

Repo: brainstem (bun + TS, bun workspaces). Depends on `@brainstem/reflexes` (build that unit first; this one imports it, does not duplicate its logic). Baseline: `packages/cli/src/harness.ts`'s existing `beforeToolCall`/`afterToolCall` wiring — read it in full before starting, this unit extracts and generalizes that exact logic, it does not redesign it.

**The one requirement that shapes everything here:** a Pi user adopting this almost certainly already has their own `beforeToolCall`/`afterToolCall` on their `Agent` for something unrelated. `attachReflexes` must **compose** with whatever is already there, never overwrite it. Confirmed from `node_modules/@earendil-works/pi-agent-core`'s types: `beforeToolCall`/`afterToolCall` are plain mutable public fields on a constructed `Agent` instance, not constructor-only config — so this is achievable by reading the agent's current hook, wrapping it, and reassigning. Do this, and only this; there is no other extension point to reach for.

## 1. packages/pi-adapter/package.json (new)

```json
{
  "name": "@brainstem/pi-adapter",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@brainstem/reflexes": "workspace:*"
  },
  "peerDependencies": {
    "@earendil-works/pi-agent-core": ">=0.86.1"
  }
}
```

`@earendil-works/pi-agent-core` is a **peer dependency**, not pinned — a consumer brings their own Pi version. Only import its exported *types* in this package's source (for the hook context/result shapes); never import runtime code from it beyond the `Agent` class type itself.

## 2. packages/pi-adapter/src/index.ts — the public surface

```ts
export interface AttachReflexesOptions {
  cwd: string;                                        // required — Gate's static floor and Focus both need a real root
  capturedTools?: Set<string>;                         // default: new Set(["bash", "read", "write", "grep", "glob"]) — which tool names get Sanitize/Verify/Focus applied to their output at all
  taskText?: () => string;                             // default: () => "unspecified" — a consumer with real task tracking should supply this; Gate/Sanitize/Focus read `task` from it on every call
  recentActivity?: () => string[];                     // default: () => [] — used as Focus's `recentFindings`
  focusMode?: "off" | "on";                            // default: "off" — matches F2's own conservative default; "shadow" is not offered here, this is a smaller surface than the full CLI harness and shadow mode's value (measuring without presenting) needs a journal to be useful, which this package does not assume exists
  onReflex?: (line: string) => void;                   // optional — receives the same short renderable lines the CLI's onReflex gets, for a consumer building their own UI
}

export function attachReflexes(agent: Agent, reflexes: Reflexes, options: AttachReflexesOptions): void
```

`attachReflexes` mutates `agent` in place (matches Pi's own idiom — `Agent` instances are already mutated this way internally) and returns nothing. Calling it twice on the same agent composes twice (each call wraps whatever is currently there) — document this plainly; it is correct behavior, not a bug, and a consumer double-attaching by mistake will just run Gate/Sanitize twice, which is wasteful but not incorrect. Do not add de-duplication guards for this — solving a mistake nobody asked us to detect adds surface area for no real benefit.

### `beforeToolCall` composition (Gate)

```ts
const originalBefore = agent.beforeToolCall;
agent.beforeToolCall = async (context, signal) => {
  const originalResult = await originalBefore?.(context, signal);
  if (originalResult?.block) return originalResult;   // respect the consumer's own block; never override it, never spend a Jev call on a call that's already refused

  if (!options.capturedTools?.has(context.toolCall.name) ?? DEFAULT_CAPTURED_TOOLS.has(context.toolCall.name)) {
    return originalResult;   // Gate only runs on tools the consumer has opted into capturing — matches capturedTools' scope, not just Sanitize/Focus's
  }

  const args = (context.args ?? {}) as { command?: string; path?: string };
  const decision = await reflexes.gate({
    tool: context.toolCall.name,
    command: context.toolCall.name === "bash" ? args.command : undefined,
    path: args.path,
    task: options.taskText?.() ?? "unspecified",
  });
  options.onReflex?.(`[gate] ${decision.action}${decision.reasons[0] ? ` — ${decision.reasons[0]}` : ""}`);

  if (decision.action === "deny") {
    return { block: true, reason: `[brainstem] denied: ${decision.reasons.join("; ")}` };
  }
  if (decision.action === "ask") {
    // This package does not implement an approval lifecycle (queuing, matching
    // a later user response back to a pending request) — that is real,
    // stateful, UI-shaped work (see packages/core/src/approval.ts and
    // packages/cli/src/harness.ts's runApproval for what it actually takes).
    // A consumer wanting real interactive approval should implement it
    // themselves using reflexes.gate()'s "ask" outcome directly, or adopt the
    // full CLI harness. Blocking on "ask" here, with a clear reason, is the
    // only safe default — silently auto-running an "ask" verdict would defeat
    // the entire point of Gate.
    return { block: true, reason: `[brainstem] needs approval: ${decision.reasons.join("; ")} (this adapter does not implement interactive approval — see @brainstem/pi-adapter's docs)` };
  }
  return originalResult;   // "auto" — defer to whatever the original hook decided (usually undefined/allow)
};
```

No change summary / diff-building for writes in v1 — that is `change-summary.ts`'s job in `packages/cli`, tied to filesystem diffing conventions that don't belong in a generic adapter. `gate()` for a `write` tool call here passes only `path`, no `changeSummary` — Gate still works (falls back to judging on tool/path/task alone, exactly as it did before P5 added change summaries), just with less evidence. State this limitation directly in the package README; do not silently degrade without saying so.

### `afterToolCall` composition (Sanitize, Verify, Focus)

```ts
const originalAfter = agent.afterToolCall;
agent.afterToolCall = async (context, signal) => {
  const originalResult = await originalAfter?.(context, signal);
  if (!(options.capturedTools ?? DEFAULT_CAPTURED_TOOLS).has(context.toolCall.name)) return originalResult;
  if (originalResult?.isError ?? context.isError) return originalResult;   // do not sanitize/focus an error result — matches packages/cli/src/harness.ts's existing rule

  // The original hook's content override, if any, is what we judge — never
  // the pre-override raw result. A consumer's own afterToolCall ran first and
  // its transformation is authoritative up to this point; we only ever act on
  // what the model would actually see.
  const effectiveContent = originalResult?.content ?? context.result.content;
  const text = textOf(effectiveContent);
  if (!text.trim()) return originalResult;

  const observed = await reflexes.observe({
    task: options.taskText?.() ?? "unspecified",
    source: `tool:${context.toolCall.name}`,
    actionSummary: `${context.toolCall.name} ${JSON.stringify(context.args)}`.slice(0, 300),
    status: "ok",
    truncated: false,
    content: text.slice(0, 8000),
  });
  options.onReflex?.(`[sanitize] ${observed.sanitize.action}`);

  let finalText = text;
  if (observed.sanitize.action === "block") {
    finalText = `[brainstem] blocked tool output (probable injected instructions): ${observed.sanitize.reasons.join("; ")}`;
  } else if (options.focusMode === "on") {
    const focused = await reflexes.focus({
      task: options.taskText?.() ?? "unspecified",
      command: context.toolCall.name,
      outcome: "ok",
      recentFindings: options.recentActivity?.() ?? [],
      content: text,
    });
    finalText = focused.text;
  }

  if (finalText === text) return originalResult;   // nothing changed — pass the original hook's result through untouched, do not manufacture a no-op override
  return { ...originalResult, content: [{ type: "text", text: finalText }] };
};
```

Notes to implement precisely, not approximate:
- `DEFAULT_CAPTURED_TOOLS` is a module-level constant `new Set(["bash", "read", "write", "grep", "glob"])`, matching `packages/cli/src/harness.ts`'s existing `CAPTURED_TOOLS`. Do not invent a different default set.
- `textOf` is a small local helper extracting joined text from a content-block array — copy the exact shape of `packages/cli/src/harness.ts`'s own `textOf`, do not reinvent its semantics.
- There is no artifact store, no `read_output`/`search_output` recovery tools in this package. Focus in `"on"` mode here means what F1 always meant literally: the model sees only what Focus selected, permanently, for this call. **This is a real, meaningful step down from F2's guarantee** that nothing is ever truly lost — F0's recovery tools are `packages/cli`-specific infrastructure (an artifact store, two extra tools registered on the agent) that this generic adapter does not bring along. State this as an explicit, named limitation in the package's README: *"`focusMode: 'on'` can omit content the model will not be able to recover later in this adapter. Use `'off'` (the default) unless you have your own way to retrieve full tool output, or adopt the full CLI harness, which includes F0's artifact recovery."* Do not soften this into vague language — a real capability gap deserves a real, specific sentence about what's actually missing and why.
- Verify's outcome (`observed.verify`) is computed by `reflexes.observe()` but **not surfaced as a content change** in this v1 — matching `packages/cli/src/harness.ts`'s existing behavior of prepending a note rather than altering meaning, decide plainly: v1 emits verify's outcome only through `onReflex` (e.g. `[verify] mismatch — ...`), not into the tool result content. A prepended-note mechanism can be a follow-up if wanted; do not build it speculatively here without being asked.

## 3. Tests

`packages/pi-adapter/test/attach.test.ts` — construct a real Pi `Agent` (same pattern as `packages/cli/test/runtime-contract.test.ts` and `harness.test.ts`: a scripted `StreamFn`, real tool call messages) with `attachReflexes(agent, reflexes, {...})`, backed by a `mockSystemOne` via `createReflexes`:

- **Composition, not replacement**: construct the `Agent` with a pre-existing `beforeToolCall` that blocks tool `"forbidden"` unconditionally and an `afterToolCall` that always appends `" [pre-existing]"` to any bash result. Call `attachReflexes`. Assert: (a) `"forbidden"` is still blocked without ever invoking the mock judge (spy the mock's call count — proves Gate is skipped when the original already blocked), (b) a bash call's final content still contains `" [pre-existing]"` when Sanitize passes it through unchanged (proves we operate on the original hook's output, not the pre-override raw result).
- **Gate deny**: a mock scripted to deny a `bash` call — the tool never actually executes (spy the real tool's `execute`), and the returned block reason contains `[brainstem]`.
- **Gate ask**: a mock scripted to return `"ask"` — call is blocked (this package has no approval lifecycle), reason mentions "needs approval" and directs the consumer to implement one or use the full harness.
- **Sanitize block**: a mock scripted to flag injected content in a `read` result — the tool result text becomes the blocked-content message, not the original file content.
- **Focus off (default)**: even with a mock that would select a subset under Focus, omitting `focusMode` (or passing `"off"`) leaves a large tool result completely unmodified by Focus (Sanitize can still act on it).
- **Focus on**: same large content, `focusMode: "on"`, mock scores one section relevant — the final tool result contains only that section's text.
- **`capturedTools` scoping**: a tool name not in the default set (e.g. a consumer's own custom tool) never triggers Gate or Sanitize/Focus at all, even when it would otherwise qualify by content.
- **Error results are never sanitized/focused**: a tool result with `isError: true` (or the original hook's override setting it) passes through `afterToolCall` completely untouched — no Jev call at all (spy the mock).

## Verify + commit

- `bun run test` green (this package's tests plus every existing test in the workspace), `bun run typecheck` 0 errors.
- Zero imports from `packages/cli` — this package depends only on `@brainstem/reflexes` and Pi's own types.
- `packages/cli`, `packages/core`, and `packages/reflexes` remain unmodified by this unit.
- Commit: `pi-adapter: @brainstem/pi-adapter — attach reflexes to any Pi Agent, composing with existing hooks`
