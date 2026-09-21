# Task: @brainstem/reflexes — a pluggable, standalone reflex library

Repo: brainstem (bun + TS, bun workspaces). Baseline: `packages/core`'s `ReflexEngine`/`SystemOne`/`jevSystemOne`, already Pi-independent and already 345 tests green. This is a **new workspace package**, not a modification of `packages/core` or `packages/cli` — those stay exactly as they are. No new GitHub org, no new repo: this ships as `packages/reflexes` in the existing monorepo; `@brainstem/reflexes` on npm is a launch-time publish decision, not something this unit does.

**Why this package exists, precisely:** `ReflexEngine` already does everything needed, but its constructor requires a `journal: Journal` and a `root: string` and expects a caller to supply `makeId`/`ids` for stable cross-event linkage — real requirements for a harness with persistence and multi-turn task/session identity, real friction for someone who just wants `await gate(...)` inline in their own agent loop with no journal at all. This package is that thin, ergonomic layer — it wraps `ReflexEngine`, it does not reimplement it. Every decision, threshold, and fallback behavior already validated across `packages/core/test/*` is inherited unchanged.

**Why "pluggable" needs a second real implementation, not just an interface:** `SystemOne` (`{name, ask(state, questions, options)}`) already IS the extension point — `jevSystemOne` is one implementation of it. Claiming pluggability while shipping only Jev makes the claim aspirational. This unit ships a second, working `SystemOne` implementation against a generic chat-completions API, so "bring your own judge" is a demonstrated fact.

## 1. packages/reflexes/package.json (new)

```json
{
  "name": "@brainstem/reflexes",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts", "./judges/generic": "./src/judges/generic.ts" },
  "dependencies": {
    "@brainstem/core": "workspace:*",
    "@typesafe-ai/sdk": "^0.6.0"
  }
}
```

Add `"packages/*"` already covers this via the root `package.json`'s existing `workspaces` field — no change needed there. `@typesafe-ai/sdk` stays a dependency here (for the `jevJudge` re-export), not a peer — it's small and this package's whole point is "works out of the box," so the default judge shouldn't require the consumer to separately install anything.

## 2. packages/reflexes/src/index.ts — the public surface

```ts
export interface ReflexesOptions {
  judge: SystemOne;                          // from @brainstem/core — the only required option
  root?: string;                              // default: process.cwd() — used by Gate's static floor path checks
  policy?: Partial<Policy>;                   // shallow-merged over policyForTrust(0.3)'s defaults; deep policy fields (e.g. policy.gate.*) are NOT deep-merged — document this explicitly, it is a real footgun otherwise
  onDecision?: (event: ReflexDecisionEvent) => void;   // optional — no journal is created unless this or journalPath is supplied
  journalPath?: string;                       // optional — when supplied, decisions are ALSO durably appended via @brainstem/core's openJournal, in addition to onDecision if both are given
}

export interface ReflexDecisionEvent {
  reflex: "gate" | "sanitize" | "verify" | "focus";
  action: string;
  reasons: string[];
  judgmentId?: string;
}

export interface Reflexes {
  gate(input: GateInput): Promise<GateDecision & { result?: AskResult }>;
  observe(input: ObserveToolResultInput): Promise<{ sanitize: SanitizeDecision; verify: VerifyDecision }>;
  focus(input: FocusLibraryInput): Promise<{ mode: FocusMode; text: string; sectionManifestHash: string }>;
}

export function createReflexes(options: ReflexesOptions): Reflexes;

export { jevJudge } from "./judges/jev";
export { genericJudge } from "./judges/generic";
export type { SystemOne, GateInput, GateDecision, ObserveToolResultInput, SanitizeDecision, VerifyDecision, FocusMode, AskResult } from "@brainstem/core";
```

Implementation of `createReflexes`:

- Construct one `ReflexEngine` internally with: `systemOne: options.judge`, `root: options.root ?? process.cwd()`, `policy: policyForTrust(0.3)` shallow-merged with `options.policy` (use `{ ...defaults, ...options.policy }` at the top level only — do not attempt a deep merge; a consumer who wants to override `policy.gate.autoConfidence` must pass the whole `gate` sub-object. Say so in a doc comment, do not silently half-merge and surprise someone), `journal`: a no-op `{ append() {} }` unless `options.journalPath` is given (then `openJournal(options.journalPath)` from `@brainstem/core`), `makeId: () => newId("j")`, `ids: () => ({ sessionId: FIXED_SESSION_ID })` where `FIXED_SESSION_ID` is generated once per `createReflexes()` call via `newId("sess")` — good enough for a library with no multi-task concept; a consumer needing real task/turn attribution should use the full CLI, not this package.
- `gate`/`observe`/`focus` are thin pass-throughs to `engine.gate`/`engine.observeToolResult`/`engine.focus`, EXCEPT:
  - `focus`'s public input type `FocusLibraryInput` is `Omit<FocusInput, "manifest"> & { content: string; artifactId?: string }` — the library builds the `SectionManifest` internally via `splitIntoSections(input.artifactId ?? "reflexes:focus", input.content)` so a consumer never has to know `SectionManifest`/`splitIntoSections` exist unless they import them directly (still exported from `@brainstem/core` for advanced use — not re-exported redundantly from this package).
  - `focus`'s return value is deliberately NOT the raw `FocusDecision` (which exposes `evaluated`/`selected` bitmaps a simple consumer has no use for and could easily misuse — recall F2's own hard-learned rule that `selected` must never be read without checking `mode` first). Instead build the actual presented text using the SAME logic as `packages/cli/src/output/present.ts`'s `presentFocused`, but reimplemented here without a Pi/artifact-id dependency (present.ts's `presentNaive` fallback needs an artifact id + a "naive first-N-lines" concept tied to `sliceByLines`, which doesn't fit a content-only library call — the "full"/"compute_or_retrieve" cases here should just mean "the whole input `content`, unmodified" as the returned `text`; there is no separate raw-capture-vs-presented-view distinction in this library since the consumer already has the raw content and decides for themselves what to do with a `"full"` verdict). Do not import from `packages/cli` — this package must have zero dependency on `packages/cli` or Pi, ever.
  - `observe`'s return type drops the internal `result: AskResult | null` field this package doesn't want to expose as part of the simple contract — actually keep `result` off the public return type entirely (it's provenance data for a harness's own journal, not something a simple library consumer acts on); a consumer who wants raw judge usage/latency should read it via `onDecision`, which is the deliberate seam for that, not by inspecting an ad hoc extra field with no journal to give it context.
- Every call routes its outcome through `options.onDecision`, if provided, as a `ReflexDecisionEvent` — construct this from the decision's own `action`/`reasons` fields; do not attempt to synthesize a fuller "reflex" event shape (that requires the full journal-event apparatus, which is `packages/cli`'s job, not this package's).

## 3. packages/reflexes/src/judges/jev.ts

```ts
export function jevJudge(options: { apiKey?: string; model?: string }): SystemOne
```

Thin wrapper constructing `new TypeSafeClient({ apiKey: options.apiKey })` (falls back to `TYPESAFE_API_KEY` env var, matching `TypeSafeClient`'s own existing behavior — do not re-implement env fallback here, just don't override it) and calling `jevSystemOne(client, options.model)` from `@brainstem/core`. This is a two-line function; do not over-build it.

## 4. packages/reflexes/src/judges/generic.ts — the second real implementation

```ts
export interface GenericJudgeOptions {
  complete: (prompt: string) => Promise<string>;   // the consumer's own LLM call — model-agnostic on purpose
  model?: string;                                   // label only, reported in AskResult.model
}

export function genericJudge(options: GenericJudgeOptions): SystemOne
```

This is deliberately the LOWEST-common-denominator judge interface: the consumer supplies a single `complete(prompt) => Promise<string>` function — however they already call whatever LLM they use (OpenAI, Anthropic, a local model, anything). `genericJudge`:

- Builds one text prompt per `ask()` call from `state` + `questions`, asking the model to respond with a JSON object keyed by question id, matching each question's `type` (`noul` → a number 0-1; `score` → a number matching the criteria's index range; `choice` → one of the criteria keys). Write the prompt so the JSON-shape instructions are unambiguous and the model is told to output ONLY the JSON object, nothing else.
- Parses the response defensively: extract the first `{...}` block (models often wrap JSON in prose or code fences despite instructions — do not assume a clean parse), `JSON.parse` it, and for each question id build the matching `Answer` shape (`{type: "noul", noul: n}` etc.) — `choice`/`score` answers need `probabilities`/`confidence` fields per `Answer`'s type; since a plain-text completion has no native confidence signal, set `confidence: 1` and `probabilities` to a one-hot-ish map centered on the chosen value (document this as an approximation, not a real calibrated confidence — a consumer relying on `genericJudge` should know its confidence field is synthetic, unlike Jev's, which is a real model output).
- On any parse failure or missing question id in the response, throw a `JevUnavailableError` (imported from `@brainstem/core`) with a clear message — this makes `genericJudge` participate correctly in `ReflexEngine`'s existing fallback/circuit-breaker handling, exactly like a real `jevUnavailable` from the SDK would, with zero special-casing needed anywhere else in the stack.
- Does NOT implement retries, deadlines, or circuit-breaking itself — `ReflexEngine` already owns all of that uniformly for every `SystemOne` implementation; duplicating it here would be redundant and could conflict.

## 5. Tests

`packages/reflexes/test/reflexes.test.ts`:
- `createReflexes({ judge: mockSystemOne(...) })` (reuse `@brainstem/core`'s existing `mockSystemOne` test helper) with NO `journalPath`/`onDecision` — `gate()`/`observe()`/`focus()` all resolve normally with no thrown error and no filesystem side effect (proves the no-op journal default actually works, not just "didn't crash because journalPath happened to be optional in the type").
- `onDecision` is called exactly once per `gate()`/`observe()` (observe should surface ONE combined event or two — decide and test whichever the implementation actually does; do not leave this ambiguous) / `focus()` call, with the correct `reflex`/`action` fields.
- `journalPath` supplied: after a `gate()` call, `loadJournal(journalPath)` (from `@brainstem/core`) contains a `"decision"` event — proves the optional durability path works, using the exact same journal format `packages/cli` already relies on (not a parallel, incompatible format).
- `focus()` with real multi-section content and a mock returning high scores for one section: returned `text` contains only that section, `mode === "select"` — proves the internal `splitIntoSections` wiring is correct without needing to import it in the test file (the point of the ergonomic API is that a consumer never touches `SectionManifest`).
- `focus()` on short/exhaustive content: `mode === "full"`, returned `text` equals the original input content verbatim (not run through `presentNaive`'s line-truncation — this package has no naive-truncation concept, only Jev's own mode decision).
- Policy override: `createReflexes({ judge, policy: { gate: { autoConfidence: 0.99 } } })` produces a different Gate outcome than the default on a borderline-confidence mock answer — proves the shallow-merge actually reaches the engine, and add a second test asserting a top-level key NOT present in the override (e.g. `policy.sanitize`) still uses the default — proves the merge is shallow-but-correct, not accidentally dropping untouched sections.
- `root` default: omit `root` entirely, call `gate()` with a write path that should hit the static floor relative to `process.cwd()` — proves the default actually resolves to the real cwd, not `undefined`/a crash.

`packages/reflexes/test/judges/generic.test.ts`:
- A `complete` stub returning clean, well-formed JSON → correctly parsed `Answer`s for a noul + a score + a choice question each.
- A `complete` stub wrapping the JSON in a code fence / a sentence before it → still parses correctly (proves the defensive extraction).
- A `complete` stub returning garbage / missing a requested question id → throws `JevUnavailableError`, and — integration point — `ReflexEngine`'s own existing fallback behavior (already tested elsewhere) kicks in correctly when `genericJudge` is used as the engine's `systemOne` (one small integration test using `createReflexes` + `genericJudge` together, not just the judge in isolation, since the actual claim is "this judge participates correctly in the real engine," not merely "this function parses JSON").

## Verify + commit

- `bun run test` green (this new package's tests plus the existing 345), `bun run typecheck` 0 errors across the whole workspace.
- Zero imports from `packages/cli` anywhere in `packages/reflexes` — this is a hard boundary, not a style preference; grep for it before committing.
- `packages/cli` remains completely unmodified by this unit.
- Commit: `reflexes: @brainstem/reflexes — pluggable, standalone reflex library`
