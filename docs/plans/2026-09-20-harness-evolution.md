# Brainstem harness evolution — implementation plan

**Date:** 2026-09-20  
**Status:** Consolidated implementation plan, revised after the live output-focus pilot. Runtime changes remain proposed; the standalone experiment is implemented.  
**Baseline:** `ae23897`, inspected with the installed Pi agent-core 0.86.1 and TypeSafe SDK.  
**Scope:** Reliable harness mechanics, useful Jev judgments, capability selection using bitmaps, Jev-guided output focusing with recoverable artifacts, faithful journaling, evaluation, provider-aware compaction, and subsequent performance work.

This plan updates the direction and sequencing in [the original implementation plan](2026-09-20-brainstem.md). It incorporates the review of [the performance analysis](../research/2026-09-20-performance.md); the latter's latency estimates and proposed turn-boundary mega-batch are not implementation requirements.

The [live output-focus pilot](../research/2026-09-20-output-focus-pilot.md) compared 12 task/output pairs in three arms, twice each: raw, actual RTK stdin filters, and Jev extraction. Jev reduced presented characters by 84.9%, with 22/24 correct first decisions versus raw's 23/24. It added latency; charging a fresh selector call per decision cost an estimated 10.7% more than raw with the inexpensive downstream model. Its two misses required an exhaustive count. Accordingly, Focus starts optional, supports a completeness bypass, and must pass outcome and economic evaluations before automatic enablement.

RTK is a comparison baseline, not a filter library to replicate. This plan's new output intelligence is a generic Jev selection mechanism. The pilot does not establish superiority over native RTK wrappers, which were not tested.

## 1. Product contract

Brainstem is a coding-agent harness that uses Jev for bounded judgments about execution, results, progress, model selection, relevant capabilities, and which output evidence the current task needs.

| Component | Owns |
|---|---|
| Harness code | Execution, permissions, approvals, cancellation, budgets, counters, context assembly, and accounting |
| Jev | Narrow semantic judgments over explicitly supplied evidence |
| Main generative model | Task strategy, investigation, proposed actions, code, and explanations |
| User | Task intent, explicit constraints, and requested approvals |

Keep `packages/core` independent of Pi. Keep Pi as the runtime. Do not build a new workflow engine or require Jev to make every non-generative decision.

Principles:

- Jev returns evidence; policy determines behavior. Capability relevance never grants execution permission.
- Preserve the original task and subsequent user constraints separately from approval responses and harness notices.
- Code computes exact facts such as counts, durations, exit codes, and budget consumption.
- Each question names fields that are actually supplied. Each reflex has an explicit unavailable outcome.
- Make judgments at the point their evidence exists. Gate precedes execution; observation follows execution; routing uses the latest completed results.
- The journal must explain the actual decision, including static rules, approval, fallback, and capability dependencies.
- Optimize against measured task outcomes and critical-path timing, not request count alone.
- Store original output separately from its presented view. Selection bitmaps govern exposure, not deletion of recoverable evidence.
- Preserve committed history during ordinary turns. Changes to tools, system instructions, and earlier messages can affect both prompt caching and opaque reasoning validity; apply provider-specific contracts.

## 2. Target behavior and integration points

```text
User task / task update
  → preserve objective and constraints
  → select initial capabilities and model
  → assemble context
  → main model proposes work
  → static checks + Jev gate + approval if needed
  → execute tools
  → capture output artifact and immutable metadata
  → choose full view or Jev-focused sections with a bitmap
  → sanitize + verify
  → commit the result delivered to the model
  → enforce budgets; pulse when due
  → refresh capabilities / route model when needed
  → assemble next context
```

Initial selection runs before `agent.prompt()`, since Pi's `prepareNextTurnWithContext` is only called after a completed turn. Later capability updates use that hook and return a complete next context with the executable tool set. Do not only change a model prompt while leaving a different set executable.

Pi currently prepares gates sequentially even in parallel execution mode; successful tools and their after-tool hooks then run concurrently. Pi awaits event subscribers. These details constrain batching, prefetch, and instrumentation.

Keep the full chronological transcript, raw output artifacts, and provider-facing views distinct. New output is focused once before commitment. Skill activation and subsequent context checkpoints must preserve the provider's prefix/opaque-block contract; keeping a reasoning block's bytes unchanged does not necessarily keep it valid after an earlier prefix edit. Verify actual provider requests, including subsequent prompts and model switches. Pi's valid tool declaration handling alone does not establish provider cache or reasoning compatibility.

## 3. Delivery sequence

Each row is a reviewable implementation unit. Update this checklist as work lands.

| ID | Work | Depends on | Status |
|---|---|---|---|
| P0 | Product documentation and runtime contract tests | — | Landed |
| P1 | Reliable tools, paths, and model resolution | P0 | Landed |
| P2 | Session evidence and journal schema v2 | P1 | Landed |
| P3 | Approval lifecycle and stable task identity | P2 | Landed |
| P4 | Jev validation, deadlines, fallbacks, and budgets | P2 | Landed |
| P5 | Better gate, sanitize, verify, pulse, and steer evidence | P3, P4 | Landed |
| P6 | Capability registry and versioned bitmap implementation | P2 | Landed |
| P7 | Jev Select and capability policy | P4, P6 | Landed |
| P8 | Skill loading, discovery, and dynamic context integration | P5, P7 | Not started |
| F0 | Bounded output artifacts and recovery tools | P1, P2, P4 | Landed |
| F1 | Generic Jev Focus, completeness policy, and section bitmaps | P5, P6, F0 | Not started |
| F2 | Focus integration and controlled rollout | P8, F1 | Not started |
| P9 | Faithful policy replay and evaluation tooling | P5, P8, F2 | Not started |
| P10 | Measured caching, batching, and journal improvements | P9 | Not started |
| P11 | Tend: deliberate provider-aware compaction checkpoints | P8, F2, P9; experimental | Not started |

Select (P7) now turns Jev judgments into `evaluated`/`recommended` bitmaps via
`ReflexEngine.select` and the CLI's `SelectDriver`, but nothing calls it from the
harness yet and `CapabilityRegistry.workingSet()`'s zero-arg call sites are
unchanged — the active set today is still baseline plus explicit. P8 is the
first unit that instantiates a `SelectDriver`, adds `find_capabilities`, and
changes the executable tool set at a turn boundary.

Develop evaluation fixtures alongside each feature, then assemble the comparison suite in P9. Dependencies express sequencing, not a requirement to delegate to multiple agents.

## P0. Document the contract and pin integration assumptions

**Files:** new `README.md`; `docs/plans/2026-09-20-brainstem.md`; `packages/cli/package.json`; `packages/cli/test/runtime-contract.test.ts`.

- Replace the ambition that Jev owns every non-generative decision with the contract in section 1. Preserve the original plan's historical results and add a link to this plan.
- Document setup, task/REPL use, the seven reflexes (Gate, Sanitize, Verify, Pulse, Steer, Select, Focus), trust behavior, approval behavior, and replay limitations. Tend is a later checkpoint workflow, not a continuously running filter.
- Pin the Pi packages to the exact compatible versions resolved in the lockfile instead of `*`. Record deliberate upgrade checks.
- Add focused scripted-runtime tests for first-turn setup, gate order, after-tool replacement, approval waiting, turn-boundary tool changes, and propagation to the next user prompt.
- Confirm a context projection can add skill instructions without corrupting tool declarations, tool-call/result pairing, or provider-specific opaque reasoning validity. Capture provider payloads in fixtures. This test determines the adapter implementation before P8; do not assume valid Pi state implies stable provider prefixes.

**Acceptance:** documented responsibilities match code boundaries, and the installed runtime's lifecycle assumptions are executable tests.

## P1. Repair tools, path checks, and model resolution

**Files:** `packages/cli/src/tools.ts`; new `packages/cli/src/paths.ts` and `models.ts`; `packages/core/src/floor.ts`; `packages/cli/src/main.ts`; focused tool/model tests.

- Accumulate stdout and stderr over all chunks. Bound retained bytes while continuing to drain both streams. Record truncation, exit code, duration, timeout, and cancellation separately.
- Combine caller cancellation and tool timeout; `signal ?? timeout` currently discards the timeout whenever a caller signal exists. Handle spawn errors and ensure the child is reaped. Test descendant cleanup on supported platforms and document remaining limitations.
- Return structured failure output so observation can inspect it; do not lose useful stderr by treating every nonzero exit as an opaque exception.
- Resolve paths from the configured `cwd` using one path utility shared by execution and checking. Handle `..`, absolute paths, sibling-prefix paths, and symlink targets. For new writes, resolve the existing parent before checking containment.
- Pass project root explicitly into the static floor. Remove its dependence on the process's unrelated working directory. Apply path checks to resolved file/search targets, not only raw argument strings.
- Preserve hard restrictions. Document that command-pattern checks do not constitute an operating-system sandbox for arbitrary bash.
- Make mutation ordering explicit: initially mark bash/write sequential to avoid parallel changes racing approval evidence. Read-only tools may remain parallel. Revisit safe concurrency after instrumentation exists.
- Resolve main and mini models independently by provider and ID. Disable routing when their complete identities match; handle an unavailable mini model explicitly.
- Remove unsupported environment assertions such as assuming a local Postgres database. Supply discovered facts or omit them.
- Validate CLI numbers and option values, including finite trust in `[0,1]`, positive deadlines, and positive pulse cadence. Correct the help text: trust zero currently means a higher auto-run threshold, not literally asking about everything.

**Acceptance:** multiple output chunks survive; collection is bounded; exit/abort/timeout are distinguishable; paths use the configured root; and same-provider main/mini routing selects distinct models.

## P2. Introduce session evidence and journal schema v2

**Files:** new `packages/core/src/evidence.ts`; `packages/core/src/journal.ts`; new `packages/cli/src/session.ts`; `packages/cli/src/harness.ts`.

Introduce stable IDs for sessions, tasks, turns, tool calls, judgments, decisions, and approvals. IDs express relationships; timestamps alone are insufficient.

```ts
interface TaskState {
  id: string;
  revision: number;
  objective: string;
  updates: string[];
}

interface ToolObservation {
  toolCallId: string;
  tool: string;
  argsSummary: unknown;
  status: "ok" | "error" | "timeout" | "cancelled" | "blocked";
  exitCode?: number;
  durationMs: number;
  excerpt: string;
  truncated: boolean;
}
```

- Record validated action data and bounded evidence explicitly. Hash full action inputs locally where necessary, without copying arbitrarily large bodies into every prompt.
- Maintain counts, repeated action hashes, elapsed time, model calls, and known token/cost totals in code. Include actual commands or paths in recent activity, not only `(tool calls)` placeholders.
- Journal v2 records schema version, policy snapshot/hash, question table/hash, actual model, judgment status, and references from decisions to their exact judgments.
- Record static-only decisions without manufacturing a judgment reference. Record approval resolution and actual execution separately.
- Record the bounded result actually delivered to the model and why it differs from the observed tool output. Do not depend on a 200-character display summary for replay evidence.
- Add artifact ID, capture completeness, section-manifest hash, presented-view hash, and focus/retrieval references. Original capture and presented view are separate immutable records.
- Record model actually used and measured spans: queue/preparation, Jev request, approval wait, tool execution, observation, model request, first token, and turn completion.
- Keep measured provider usage separate from estimated costs. Represent unknown cost as unknown, not zero. Record session end on normal shutdown and failure where possible.
- Initially preserve full question bodies in the journal and retain synchronous appends. Remove redundant `mkdir` from the session's append path; retain standalone helper compatibility.

**Acceptance:** interleaved activity can be attributed to the correct task, call, judgment, and decision; no event needs a “last matching event” heuristic.

## P3. Implement approval as a harness lifecycle

**Files:** new `packages/core/src/approval.ts`; `packages/cli/src/harness.ts`, `session.ts`, and `main.ts`; approval integration tests.

Add an injectable callback:

```ts
type ApprovalResolution = "approve_once" | "deny";

interface ApprovalRequest {
  id: string;
  taskId: string;
  toolCallId: string;
  cwd: string;
  tool: string;
  validatedArgs: unknown;
  actionHash: string;
  reasons: string[];
}
```

- Gate `ask` opens a pending approval and waits inside the pre-execution hook. Approval permits that validated action once; denial returns a clear blocked result. Hard denials never enter this flow.
- Use one CLI input controller for normal tasks and approvals. Approval responses must not become user task messages. Queue unrelated task updates through an explicit path; an update that changes the pending action's context invalidates the approval request.
- Show the exact command or file change and working directory. Bind approval to action inputs and relevant preconditions; an edited file must not change between the reviewed diff and write without revalidation.
- Handle cancellation and EOF explicitly. Neither elapsed time nor an empty response approves execution. Noninteractive runs without an approval handler return a distinct approval-required outcome and nonzero CLI status.
- Preserve the session objective plus task updates. Add an explicit API for starting a new task; do not infer a new objective from every `prompt()` string.
- Log requested, resolved, cancelled, consumed, and invalidated approvals. Do not auto-repeat an approved action after process restart; crash-safe exactly-once execution is outside this increment.

**Acceptance:** approve once executes once within the active run; denial/EOF/cancellation execute nothing; “yes” does not replace the objective; two pending actions cannot consume one another's approval.

## P4. Validate judgments and define runtime failure policy

**Files:** `packages/core/src/types.ts`, `providers/jev.ts`, `providers/mock.ts`, `engine.ts`, `policy.ts`; new `validation.ts`; harness cancellation/budget integration.

- Extend `SystemOne.ask` with an options object carrying cancellation and an operation deadline. Keep the mock compatible with the new contract.
- Validate response IDs and types against the question table; finite numeric ranges; choice membership; score range; probability structure; and required confidence fields. Do not invent missing confidence or silently map malformed answers to reassuring defaults.
- Validate fused requests by reflex group: a broken verify group must not hide a valid sanitize block, and an incomplete sanitize group cannot pass content.
- Represent completed, unavailable, and cancelled judgments distinctly. Deterministic decisions consume these outcomes rather than `undefined` values.
- Use an operation-wide abort signal that covers attempt timeouts and retry backoff. Start with retries disabled on blocking reflex calls. Make the initial 1.5-second deadline configurable and provisional pending evaluation.
- Add a small circuit breaker shared by the configured provider: initially open after three consecutive transient failures, allow one probe after a 10-second cooldown, and reset on success. Make values configurable; exclude user cancellation from failure counts and do not cache failures as answers.
- Add deterministic configurable budgets for model calls, elapsed time, and known spend. Enforce them independently of Pulse. Unknown cost cannot support a hard spend guarantee; other configured budgets remain enforceable.

| Reflex | Unavailable behavior |
|---|---|
| Gate | Keep static denial; otherwise request explicit approval |
| Sanitize | Withhold unchecked excerpt and return a clear observation error |
| Verify | Unknown; no claim that the result succeeded |
| Pulse | Record unavailability; continue only within deterministic budgets |
| Steer | Use configured main model |
| Select | Retain the last valid allowed set; initially use baseline plus available explicit requirements and discovery |
| Focus | Preserve an unfiltered bounded view with explicit coverage and recovery; still sanitize the exact delivered content |

Cancellation stops the operation; it must not be converted into an approval request or a new provider call. Document these behaviors in the README and keep trust from changing safety fallbacks implicitly.

**Acceptance:** outages, retry delays, malformed answers, open circuits, and caller cancellation produce bounded and distinguishable outcomes without forwarding unchecked content.

## P5. Improve each existing reflex's evidence and policy

**Files:** `packages/core/src/questions.ts`, `engine.ts`, `policy.ts`, `evidence.ts`; `packages/cli/src/harness.ts`, `tools.ts`; reflex fixtures/tests.

### Gate

- Send the actual tool/action, task, and relevant environment facts. For writes include a bounded diff or change summary and whether evidence is incomplete; do not judge only `write file <path>`.
- Avoid duplicating whole file bodies in tool intent strings. Separate the immutable action hash used for approval from bounded semantic evidence sent to Jev.
- Handle missing decisive evidence conservatively. Keep static floor enforcement separate from Jev's response.
- Either apply `writes_outside_project` through an explicit policy rule or remove the unused question. Resolve literal containment in code; Jev can judge uncertain command effects.
- Preserve separate risk, relevance, and disposition signals. Evaluate any change to how these combine against the existing gate corpus before changing thresholds.

### Sanitize and Verify

- Build one bounded content envelope before observation. With F0/F1, it is either a complete bounded view or a Jev-selected view backed by the original artifact. Send that exact envelope to sanitize, including retained stderr/error text. Deliver no unseen tail to the main model. Artifact pagination recovers later sections through new checked calls without rerunning the command.
- Carry task, source, action summary, stated intent when present, result status, and truncation information. Use the same envelope when passing, annotating, or replacing output.
- Distinguish a tool's operational failure from failure to satisfy investigative intent. Reproducing a failing test may be useful and intentional.
- Keep sanitize and verify fused, with disjoint answer IDs and explicit per-group validation. Use score confidence only where the policy actually specifies it; add true uncertainty tests.
- Test harmless documentation and normal agent-facing project instructions against attacks. “Contains instructions” alone should not be treated as evidence that the instructions are malicious without evaluating the policy on benign cases.
- Keep raw content withheld until sanitize completes. Sanitizer error handling is not an optimistic background path.

### Pulse

- Send structured recent actions, result statuses, repeated-input counts, repeated failure fingerprints, and observed changes between attempts.
- Ask whether the approach changed meaningfully and whether the observed work advances the objective. Do not ask Jev to count commands or calculate budgets.
- Make interventions specific to the evidence and avoid issuing the same intervention repeatedly without new evidence. Hard budget exhaustion remains a deterministic stop/pause.

### Steer

- Use latest completed results and current task context. Include the capabilities available for the next step where relevant. Consider cache continuity and provider-specific reasoning-block compatibility when switching models, not only per-token model price.
- Skip the reflex if no distinct mini model is configured. Keep main-model fallback on uncertainty or failure.
- Record the chosen and actually used model. Test behavior after a mechanical task reveals an ambiguous failure.

**Acceptance:** fixtures cover identical commands with different supplied context, successful investigation of a failure, malformed evidence, repeated commands after actual changes, benign instructions, and injections beyond the old 8,000-character prefix.

## P6. Build a capability registry and use bitmaps from the start

**Files:** new `packages/core/src/capabilities.ts` and `bitmap.ts`; new `packages/cli/src/capabilities/registry.ts`; exports and tests.

Use real bitmaps for set membership. Keep them out of the Jev prompt: Jev receives meaningful descriptions, and code converts validated judgments into bits.

```ts
interface CapabilityDescriptor {
  id: string;                    // e.g. tool:read, skill:frontend-debugging
  kind: "tool" | "skill";
  version: string;
  description: string;
  useWhen: string[];
  avoidWhen: string[];
  requires: string[];             // stable capability IDs
  alwaysAvailable: boolean;
  contentHash: string;            // schema or instruction/resource manifest
}

interface CapabilityBitmap {
  catalogHash: string;
  bitLength: number;
  bytes: Uint8Array;
}
```

Catalog and encoding rules:

- Compile an immutable catalog sorted by stable ID using a specified lexical ordering. Reject duplicate IDs, missing dependencies, and dependency cycles initially.
- Hash the canonical descriptors, dependency lists, content hashes, ordering, and schema version. Never interpret a bitmap without its matching catalog.
- Bit `i` belongs to catalog entry `i`. Store it in byte `floor(i / 8)` with mask `1 << (i % 8)`; bit zero is the least significant bit of byte zero.
- Byte length is `ceil(bitLength / 8)`; unused final-byte bits must be zero. Validate bounds and catalog equality for all operations.
- Implement empty/full, membership, set/clear, union, intersection, difference, equality, population count, and ID conversion. Do not use one JS integer as the whole bitmap or rely on shifts beyond 31 bits.
- Encode journal bitmaps as `{catalogHash, bitLength, encoding: "base64-lsb0", data}`. Decode to `Uint8Array` in memory. Retain a catalog snapshot for decoding old journals.
- Derive human-readable selected IDs from the bitmap and catalog. Debug output may include them, but they are not a second independently mutable source of truth.
- Catalog changes require remapping by stable ID and recomputing policy/dependency eligibility. Never reuse old positional bits against a new catalog.

Maintain separate masks for `available`, `baseline`, `explicit`, `evaluated`, `recommended`, and `active`. The `evaluated` mask distinguishes a low score from an item never assessed. Availability is supplied by code from registration and configuration; Jev cannot change it.

The actual active set is a dependency-complete selection of baseline, explicit, currently pinned workflow capabilities, and recommendations, constrained by availability and context policy. If a dependency is unavailable, reject the dependent optional capability; report unmet explicit requirements. Do not silently intersect away dependencies and leave a broken skill active.

**Acceptance:** test empty catalogs; 7/8/9, 31/32/33, and 63/64/65 boundaries; randomized set equivalence; serialization; invalid padding; version mismatch; catalog reorder/remap; and unavailable dependencies. No compressed bitmap library is necessary at this scale.

## P7. Add Jev Select and deterministic selection policy

**Files:** new `packages/core/src/selection.ts`; `questions.ts`, `engine.ts`, `policy.ts`, `types.ts`; selection fixtures/tests.

```ts
interface SelectInput {
  task: TaskState;
  recent: ToolObservation[];
  catalog: CapabilityDescriptor[];
  available: CapabilityBitmap;
  current: CapabilityBitmap;
  explicit: CapabilityBitmap;
  discoveryQuery?: string;
}

interface SelectDecision {
  evaluated: CapabilityBitmap;
  recommended: CapabilityBitmap;
  active: CapabilityBitmap;
  scores: Record<string, number>;
  reasons: Record<string, string[]>;
  status: "ok" | "partial" | "unavailable";
}
```

- Ask one independently scoped Noul per eligible optional capability in a batched request: would this capability help perform the next work implied by the task and recent evidence? Reference each candidate's description and applicability boundaries directly.
- Permit multiple or zero relevant capabilities. Do not threshold a single Choice distribution as independent relevance. Noul has no separate confidence field.
- Code always includes available baseline capabilities and honors explicit user selections without relying on Jev to rediscover them. Skill/tool prerequisites are resolved in code.
- Start with configurable, explicitly experimental thresholds: add at `0.65`, retain an already active optional item at `0.45`. Retain unevaluated active items until a deliberate refresh or invalidation. Record why each item was added, retained, pinned, excluded, or evicted.
- Enforce an optional-context budget using measured schema/instruction size estimates. Select optional capability bundles with their dependencies using stable score/ID ordering. Mandatory baseline/explicit/workflow bundles are not silently dropped to fit; surface an over-budget state for context management.
- Keep active workflow skills pinned until an explicit release/completion decision or task change. Record workflow activation/release so availability does not oscillate with small score changes.
- Refresh on initial task, task/constraint update, explicit discovery, registry change, or materially new evidence such as a new failure class. Use deterministic trigger facts and a minimum refresh interval; do not make every token or minor tool result trigger a request.
- For a modest registry, assess all descriptions. If serialized requests exceed configured size limits, split candidates into bounded independent batches and preserve evaluated/unknown status. Add coarse retrieval plus deeper reranking only after recall evaluation warrants it.
- Loading full bodies is separate from selection. Changing a descriptor or body hash invalidates its selection input/cache identity.

**Acceptance:** none/one/many selection; explicit requirements; dependency closure; low-score vs unevaluated distinction; stable retention; missing responses; size limits; catalog changes; and selection that never enables an unavailable capability.

## P8. Load skills and expose the selected working set

**Files:** new `packages/cli/src/capabilities/skills.ts`, `discovery.ts`, and `context.ts`; `harness.ts`, `main.ts`, `tools.ts`; new configured skill fixtures.

- Define a local skill loader for configured roots. Read frontmatter/manifest metadata into descriptors, preserving full `SKILL.md` content and resource references separately. Use stable namespaced IDs; validate paths and dependency declarations.
- Add CLI/configuration for skill roots, explicit skills, selection settings, and baseline tools. Initially register the existing five tools as baseline; selection's first useful reduction will come from optional skills and later specialized tools.
- Add `find_capabilities({query})` as an always-available discovery tool. It searches eligible descriptors, schedules activation through selection policy, and returns selected IDs or an explicit no-match/unavailable result. Apply the new tool set at the next model boundary, not midway through an already emitted tool batch.
- Give discovery access to all available candidates rather than only the current active subset. On Jev failure, return a bounded deterministic candidate list and allow explicit capability requests so a false negative does not trap the agent.
- Resolve selected tool IDs to their exact `AgentTool` instances. Return the updated executable context from Pi's next-turn hook and keep session tool state consistent for later `prompt()` calls.
- Build a deterministic skill instruction block from active skills. Load it before the initial request and keep it stable within a task phase. Never let a skill override the harness's top-level contract.
- Add a provider context adapter describing deferred-tool support, system/tool update semantics, protected reasoning blocks, model-switch behavior, and compaction support. Prefer verified provider-native deferred loading where possible. Otherwise defer optional tool/skill removals until a phase/checkpoint boundary; capability revocation remains immediate even if it incurs a cache reset.
- Treat any unavoidable prefix change as explicit: preserve, restart at a checkpoint, or use the provider's documented transition. Do not resend opaque blocks against an invalidated prefix. Record the transition and its cost.
- Keep the stable prompt prefix stable where provider support allows; measure cache creation/read tokens and actual request bytes instead of assuming a smaller dynamic tool list is cheaper. Active bitmaps still govern the selected working set; their update cadence follows this policy.
- Provide bounded resource reads for a skill's referenced files. Loading instructions does not execute scripts, connect accounts, or approve actions.
- Journal catalog, selection, activation, instruction hashes, and tool-set changes. Preserve full instructions in resolvable versioned artifacts for audits.

**Acceptance:** the first model request sees the selected skills; an optional tool becomes callable only after activation; removed tools stop being executable; discovery recovers an omitted capability; active workflow skills persist; subsequent prompts use the correct set; and the projected context preserves valid historical tool pairing.

## F0. Store original outputs and make omitted evidence recoverable

**Files:** new `packages/core/src/artifacts.ts`; new `packages/cli/src/output/artifact-store.ts`, `recovery-tools.ts`; `tools.ts`, `harness.ts`, `journal.ts`; artifact/retrieval tests.

- Stream original stdout and stderr into bounded local artifacts while retaining exit status, command identity, encoding, stream boundaries, timestamps, and byte counts. Artifact retention has explicit byte/session limits and expiry. If capture hits a limit, record the missing range; do not promise recovery of discarded bytes.
- Give each captured result a stable ID and content hash. Store the capture before presenting a reduced view. Session-level access checks apply; an artifact ID is not a permission grant for arbitrary filesystem paths.
- Add always-available `read_output({id, startLine, lineCount})` and `search_output({id, pattern, limit})`. Responses include actual source ranges and completeness markers. Bound regex work or use a safe search implementation. Recovery never reruns the original command.
- Add a generic deterministic computation path for whole-output operations: search counts and simple metadata counts where the operation is exact. More involved computations can be proposed through the normal gated tools against retained artifacts; do not ask Jev to count records.
- Apply the same final-content sanitization to every recovery response. A rendering/compression fallback is allowed to pass through content only after normal sanitization.
- Record read/search requests and presented source spans so evaluation can measure how often omitted evidence was needed. Source values are untrusted even when a formatter places them next to harness metadata.

**Acceptance:** recover a value omitted from an earlier view without executing a command again; distinguish expiry, unknown ID, capture truncation, empty source, and withheld content; preserve separate failure/status metadata; and block unsafe content equally in initial and recovered views.

## F1. Implement generic Jev Focus using actual output evidence

**Files:** new `packages/core/src/output-focus.ts`, `output-sections.ts`; shared `bitmap.ts`; `questions.ts`, `policy.ts`, `engine.ts`; evidence-selection fixtures.

```ts
interface OutputSection {
  id: string;
  artifactId: string;
  startByte: number;
  endByte: number;
  text: string;
  requires: string[];              // parent header / neighboring interpretation context
}

interface FocusDecision {
  mode: "full" | "select" | "compute_or_retrieve";
  status: "ok" | "partial" | "unavailable";
  sectionManifestHash: string;
  evaluated: CapabilityBitmap;      // shared versioned bitmap mechanics, distinct manifest
  selected: CapabilityBitmap;
  scores: Record<string, number>;
  reasons: string[];
}
```

Rename the reusable bitmap type to `VersionedBitmap` during extraction of shared code; keep capability and section manifests in distinct namespaces so they cannot be accidentally combined.

Implementation rules:

- Split output using generic structural boundaries: paragraphs, records, headings, and line windows. Preserve exact source text and UTF-8 byte offsets. The pilot used UTF-16 string offsets; production must specify and test byte/line semantics, Unicode boundaries, and independent stdout/stderr spans.
- Group context-dependent records with their labels/headers, or record dependency edges and select their closure. Do not cut a test assertion from its test name, or a commit body from its identity, solely to meet a fixed chunk size.
- Supply the current task, actual command, intent, outcome, recent findings, and actual candidate section content. Never replace the very result being judged with only a status/length note.
- First determine whether selective extraction is applicable. Explicit full-output requests, short outputs, exact reproduction, and clearly exhaustive tasks bypass it. Add a Jev question for less obvious completeness needs; unknown applicability favors preserving evidence.
- For eligible outputs, ask independently scoped relevance questions per candidate. Optional questions can identify contradictions to the current hypothesis or evidence of an already-failed approach. Keep literal values verbatim; Jev does not generate summaries.
- Convert validated scores into a selected bitmap under an explicit view budget, with mandatory metadata and section dependencies handled in code. The pilot's threshold/budget are experimental starting points, not production-calibrated constants.
- Use separate evaluated/selected masks. Unassessed content is not irrelevant. If all necessary evidence cannot fit or be judged, present an explicit incomplete view with retrieval guidance, or bypass selection.
- Use token budgets when the provider tokenizer is available; otherwise conservative byte budgets with labeled estimates. Huge raw outputs require bounded candidate windows/retrieval. Do not silently assess one prefix and claim to have selected from the entire artifact.
- Maintain metadata outside Jev's selection: original source size, capture limits, command, exit status, artifact ID, selected coverage, and whether omission occurred. No selected sections must not render as an empty tool result or a successful search with no matches.
- Keep an economically informed eligibility rule. Initial rollout: explicit opt-in and a configurable minimum output size. Later compare estimated selector cost and measured recovery risk with the expected downstream cost, including cache reads/writes. Cheap models may make focusing uneconomic even at substantial text reduction.

**Acceptance:** local evidence survives without rewriting; a failed assertion remains attached to its context; passing timing/skipped tests can be selected when relevant; exhaustive-count tasks bypass selection; Unicode/source spans round-trip; absent, unavailable, unassessed, and empty are distinct; false negatives can recover through F0.

## F2. Integrate Focus once per new result and roll it out conservatively

**Files:** `packages/cli/src/harness.ts`; new `packages/cli/src/output/present.ts`; policy/configuration, journal events, scripted integration tests.

- Integrate `capture → applicability/full view or focus → exact final-view sanitize + verify → commit`. Preserve the original artifact even if the presented view is blocked. Normal tool permissions still apply.
- Keep the presented result immutable after commitment. Later requests reuse that exact view; recovery appends new evidence. Do not recompute old views every turn based on a changed relevance score.
- Modes: `off`, `shadow`, and `on`. Off uses bounded original views with recovery; shadow records selections and costs but presents the original; on presents the focused view. Retain static checks/sanitization in every mode.
- Enable Focus per output kind/size and downstream model only after evaluation supports it. The default remains off or shadow during development. Avoid adding a selector network call for small outputs.
- Cache exact selection evidence with artifact hash, manifest version, question/policy inputs, task revision, and recent-evidence identity. A changed task requires a fresh selection for any new view. Keep cache provenance and zero new API usage on hits explicit.
- Surface useful receipts to the agent: selected sections, omitted coverage, original status, and how to retrieve more. Do not expose internal scores unless they help the agent decide whether more evidence is needed.
- Record both initial and recovery costs; report estimates separately from measured API usage. Distinguish actual selector reuse from a hypothetical fresh-call scenario.

**Acceptance:** selected output is never treated as the whole artifact; selection cannot bypass sanitizer or approval; recovery does not rerun side effects; old views stay unchanged; and complete versus selective modes can be compared under the same harness behavior.

## P9. Make replay faithful and evaluate usefulness

**Files:** `packages/cli/src/replay.ts`, `main.ts`; new `packages/core/src/replay.ts` if shared logic warrants it; new `experiments/evals/` fixtures and runner; package scripts; replay tests.

### Replay

- Resolve each decision through its judgment ID, static verdict, approval references, policy snapshot, catalog, and supplied evidence.
- Replay the original policy exactly. For a new policy, recompute deterministic decisions and bitmap dependency/budget rules from recorded valid scores. Mark candidates without recorded scores as unevaluated; never invent them.
- Distinguish policy replay (offline reuse of scores) from question/model re-evaluation (new API calls). Require an explicit CLI mode for re-evaluation and report estimated/actual usage.
- Do not replay tool side effects. Human approval remains a recorded historical outcome; changed policy cannot manufacture new consent.
- Read legacy journals in a clearly labeled best-effort mode. Ambiguous/static-only records lacking necessary references are unsupported, not silently associated with unrelated prior scores.
- Present decision differences as counterfactual policy outcomes on recorded evidence, not proof that a full agent run would have followed the same trajectory.

### Evaluation

- Create small reproducible scenarios: mechanical edit, ambiguous debugging, error reproduction, repeated failure after a real change, approval-required action, malicious output, benign instructions, unavailable Jev, and misleading apparent success.
- Create capability fixtures for none/one/multiple relevant skills, similar descriptions, missing dependencies, explicit selection, and phase changes requiring a new capability.
- Retain the completed [output-focus pilot](../research/2026-09-20-output-focus-pilot.md) as a baseline. Extend it to native RTK wrappers and an equal-budget generic head/tail baseline; record differences in the actual underlying commands. Do not market the recorded stdin-filter comparison as a general RTK result.
- Add output-focus tests for whole-output counting, unknown/negative evidence, multi-section dependencies, warnings among passing results, late source values, and unsupported formats. Distinguish answer accuracy, exact quotation fidelity, completeness, and structured-response validity.
- Include a held-out labeled set. Journal predictions are candidate training data, not ground truth; allow reviewed labels and corrections to be attached by ID.
- Run scripted integration tests without network access. Keep live evaluations explicit, with bounded tasks and spend limits; do not run them in the normal unit suite.
- Support controlled ablations of Select, Steer, Verify, Pulse, and Focus. Keep static restrictions and approval semantics constant. Evaluate sanitize/gate on controlled corpora rather than disabling protection during ordinary work.
- Record task completion, incorrect execution/withholding, unnecessary approvals, intervention usefulness, selection recall and irrelevant loads, discovery recovery, context tokens, actual model usage, cost, and time.
- Report per-reflex request durations and critical-path contribution separately, with sample size and workload configuration. Separate cold/warm calls, human waiting, tool execution, provider latency, and cache hits.
- Compare complete coding tasks and multiple downstream model tiers, including multi-turn prompt-cache behavior. Require a predeclared acceptable outcome-regression bound on held-out tasks and demonstrated cost/context benefit for each automatic Focus policy; thresholds are chosen before the validation run, not after inspecting it. The current 12-case pilot is insufficient to enable automatic focusing globally.

**Acceptance:** original-policy replay has no unexplained changes in v2 fixtures; selection results round-trip through catalog+bitmap records; reports identify both missed capabilities and excess exposure; and a reproducible baseline exists before performance claims are revised.

## P10. Optimize the corrected harness using measurements

**Files:** new `packages/core/src/cache.ts`; engine/provider interfaces as needed; `journal.ts`; harness integration; timing experiments; revised performance research document.

Implement in this order, validating behavior and measuring each change separately:

1. **Exact-answer cache and in-flight deduplication.** Key by provider identity/configuration, pinned model, canonical state, and full question table version/content. Cache only successful validated answers; rerun current policy and static checks on every use. Include relevant task/catalog/evidence revisions in state. Do not cache permissions, approvals, cancellations, or failures. Bound entries and bytes. Report hits with zero new provider usage and preserve original provenance separately.
2. **Optional journal seeding.** Explicitly select compatible prior journals and load their exact successful answers. A new timestamped journal does not implicitly contain prior sessions. Do not assume fresh real-world state merely because serialized input is identical.
3. **Gate batching where independence is established.** Evaluate multiple pending independent actions in one request with per-action IDs and explicit state paths. Preserve static decisions and approval bindings. Sequential mutations needing post-action evidence stay sequential; do not batch stale judgments solely to reduce request count.
4. **Post-result pulse/steer/select fusion.** Combine only due judgments whose inputs exist at the same boundary. If Pulse adds an intervention or a user update arrives, invalidate/recompute affected routing or selection. Preserve separate validation groups. Do not move all three before tool execution.
5. **Journal sink.** If profiling justifies it, use an ordered buffered writer with backpressure, surfaced errors, explicit `flush()`/`close()`, and shutdown draining. Define whether decision records must flush before effects. Deduplicate question bodies by hash only after persisting the referenced bodies. State the crash-loss window; asynchronous buffering is not free durability.
6. **Optional gate prefetch.** Start nonblocking judgment work on Pi's completed-tool-call stream events when there is useful remaining generation time. Validate final arguments and action identity before consuming results. Never execute speculatively. Do not await the prefetch inside the awaited event subscriber. Cancel abandoned work and journal predictions separately from applied decisions.

Connection warm-up remains a measured experiment: keep it only if it improves user-visible startup without moving the same delay earlier or creating unnecessary calls. No fixed latency saving is promised.

**Acceptance:** correctness fixtures remain unchanged, actual critical-path latency improves on representative workloads, cache provenance is accurate, and performance documentation reports measured distributions rather than multiplying one synthetic p95 by request count.

## P11. Implement deliberate compaction checkpoints after evaluation

**Files:** new `packages/core/src/context-checkpoint.ts`, `context-selection.ts`; new `packages/cli/src/context/checkpoint.ts` and provider adapters; context fixtures and evaluation scenarios.

- Trigger only at measured context pressure or an explicit checkpoint request, with headroom for the next model/tool interaction. Do not continuously delete earlier messages to minimize nominal context size.
- Before transition, allow the main model to write a structured checkpoint through a constrained harness operation. Required fields: objective, user constraints, completed changes, unresolved work, failed approaches and findings, latest verification, active skill requirements, and artifact references. Validate references and retain the checkpoint itself as a versioned artifact.
- Code pins user constraints, approval outcomes, unresolved state, and provider-protected message groups. Jev can identify relevant supporting evidence and flag apparent omissions after seeing the actual evidence. It cannot summarize or inspect opaque reasoning payloads.
- Use a provider's supported compaction/context-management operation when the adapter supports it. Otherwise explicitly start a new context from the checkpoint, selected original evidence, and recent complete interactions. Do not splice old history and assume retained reasoning blocks remain valid against the altered prefix.
- Preserve native opaque blocks exactly when continuing their valid context; when switching models or starting a new context, follow the provider's explicit rules rather than copying foreign/invalid blocks. Protocol fixtures must cover these transitions.
- Chunk bitmaps reference immutable evidence manifests. They select what to carry into the checkpoint context; they do not authorize edits to the committed source transcript.
- Keep the full transcript and retained artifacts available for recovery, subject to declared retention limits. Validate the new context before committing the transition. If compaction fails, retain the old state and use a supported fallback or pause when the context limit prevents continuation.
- Measure cache rewrites, cache reads, reasoning-block compatibility, forgotten constraints, repeated failed approaches, retrievals, and task success alongside token savings. Use both single-transition and repeated-compaction tests. Keep this experimental until a held-out long-task evaluation supports it.

**Acceptance:** checkpoints preserve constraints and failed-attempt evidence; valid provider transitions preserve reasoning continuity where supported; failure cannot corrupt the original session; and long-task evaluations demonstrate a useful cost/context tradeoff within the preregistered outcome bound.

## 4. Verification and release criteria

For each implementation unit, run focused tests and `npm run typecheck`. Run `npm test` at integration milestones. Add tests for meaningful behavior and failure boundaries, not implementation-shaped assertions.

Required integration scenarios before calling this iteration complete:

- [x] A multi-chunk command returns accurate bounded output and exit status.
- [ ] Cancellation during execution, approval, selection, and Jev retry waiting settles the run.
- [x] A custom `--cwd` is used consistently by tools and static checks.
- [x] An approved action executes once in the active run; denial and EOF execute nothing.
- [x] Approval responses preserve task identity and constraints.
- [x] Every delivered tool-output excerpt has been checked, including error output and paginated tails.
- [x] Verification distinguishes an intentionally reproduced failure from an unhelpful result.
- [x] Main/mini routing changes the actual model, or skips routing when identical.
- [ ] Capability selection supports none/one/many, dependencies, explicit requirements, and discovery recovery.
- [x] Bitmap serialization, version validation, and catalog remapping are correct beyond 32 and 64 entries.
- [ ] Generic output sections preserve exact evidence, source identity, dependencies, and tested Unicode offsets.
- [ ] Exhaustive requests bypass selective focusing; computations use code rather than Jev counting.
- [x] Omitted output is recoverable without rerunning commands; capture truncation and expiry are explicit.
- [ ] Focusing changes only new presented results, and recovery receives normal sanitization.
- [ ] The provider sees the intended tools/skills on initial calls, later turns, and subsequent user prompts.
- [ ] Tool/skill changes and checkpoints respect provider cache/opaque-reasoning contracts, not only tool pairing.
- [ ] Journal v2 explains each decision and original-policy replay reproduces it.
- [x] Outages follow the documented fallback table; hard budgets remain independent of Jev.
- [ ] Evaluation reports outcomes, selection errors, cost, context size, and measured critical-path timing.

## 5. Deliberate exclusions and later research

- **Optimistic sanitize:** excluded because it forwards content before the judgment that is supposed to control exposure. It is a different enforcement model, not a transparent optimization.
- **Local gate distillation:** deferred until there is a reviewed dataset, held-out evaluation, and hardware-specific measurements. Fifty-eight commands and unreviewed Jev labels do not establish a substitute gate's coverage.
- **Full crash-resumable execution:** deferred; this plan makes evidence and approvals explicit but does not claim exactly-once side effects after a crash.
- **An RTK clone:** excluded. RTK remains a baseline or future optional adapter; Brainstem's new feature uses Jev over generic evidence sections rather than building a per-command filter catalog.
- **Always-on historical pruning:** excluded. Focus operates before a result enters history; Tend operates at explicit provider-aware checkpoints.
- **Compressed bitmap stores:** deferred until catalog sizes justify them. A versioned `Uint8Array` already provides compact, deterministic membership for capabilities and output sections.
- **Full-catalog instruction loading into Jev:** descriptions first, bounded detailed evidence when needed. Catalog size and relevance quality must be measured.

## 6. Reference material

- [Original Brainstem implementation plan](2026-09-20-brainstem.md)
- [Performance analysis under review](../research/2026-09-20-performance.md)
- [Completed Jev output-focus pilot](../research/2026-09-20-output-focus-pilot.md)
- [Reproducible pilot and saved evidence](../../experiments/output-focus/README.md)
- [Inverted harness research](../research/2026-09-20-inverted-harness.md)
- [TypeSafe: independent Noul judgments](https://docs.typesafe.ai/primitives/noul)
- [TypeSafe: speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)
- [TypeSafe: skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) — related ranking/reranking example; its single-skill recommendation does not itself validate Brainstem's proposed multi-capability filtering.
- Installed Pi `dist/agent-loop.js`, `dist/agent.js`, and `dist/types.d.ts` — implementation source for lifecycle and dynamic-tool assumptions; recheck when upgrading.
- [Anthropic context editing and prefix implications](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Anthropic deferred tools and cache preservation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- [RTK v0.49.0](https://github.com/rtk-ai/rtk/releases/tag/v0.49.0) — real stdin-filter baseline used by the pilot, not a substitute for testing its native wrappers.
