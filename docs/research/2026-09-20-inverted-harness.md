# The Inverted Harness — Design Document

**Research date:** 2026-09-20. Primary sources verified via webfetch: docs.typesafe.ai (`/llms.txt`, `/primitives`, `/primitives/choice`, `/confidence`, `/patterns` + 3 pattern pages, `/cookbooks/function_calling`, `/cookbooks/hierarchical_classification`, `/model-jaggedness/jev-1.13`, `/concepts/how-to-build-with-system-one`, `/models`), evals.typesafe.ai, Anthropic "Building Effective Agents" (Dec 19, 2024), Cognition "Don't Build Multi-Agents" (Jun 12, 2025) and "Multi-Agents: What's Actually Working" (Apr 22, 2026), Simon Willison's agent-definition post (Sep 18, 2025), Cognition/Prefect blog indexes. Temporal/Inngest/Step Functions/LangGraph details from training knowledge where fetches 404'd; flagged as such below.

---

## 0. Executive summary

The inversion is sound, but it is less novel than the framing suggests — and that's good news. TypeSafe's own docs already preach exactly this architecture ("code owns the workflow and AI handles narrow, structured decisions"; "avoid agent `while` loops when a software workflow can express the same behavior" — /concepts/how-to-build-with-system-one), and their workflow-evals site provides the empirical case: averaged over four tasks, **every model was more accurate, cheaper, and faster as a workflow than as one big prompt**, with Jev at 67.8% mean accuracy, $0.0004/case, 0.4s — vs. Haiku 4.5 as a prompt at 18.1%, $0.036, 21.2s.

What does *not* exist, and what this design contributes, is the **harness as a governed artifact**: question tables as versioned, diffable data; confidence-gated edges as policy rather than discipline; an event log that makes every workflow run replayable against a new question-table version; and an eval loop built on reference probabilities. The design below is: an **event-sourced reducer core** (functional core, imperative shell), deployed on an **existing durable engine** (Temporal / inngest / Step Functions) for production, with **LangGraph as the honest build-vs-buy comparison**. The MVP is a CI-triage bot that calls a generative LLM exactly once.

The skeptical bottom line, up front: **for one or two workflows, this is overkill — call Jev inline, as the docs show in Python.** The harness earns its existence at the point where question tables, thresholds, and decisions need version control, audit, offline tuning, and regression testing as first-class objects — i.e., when the *policy*, not the code, is the thing under active development.

---

## 1. Ground truth: what Jev actually is (verified)

| Property | Verified value |
|---|---|
| Model | `jev-1.13.0` (aliases `jev-latest`, `jev-preview` — both currently point to 1.13.0) |
| Primitives | **Choice** (≤255 options → `choice` + `probabilities` + `confidence`), **Score** (ordered levels → `score` + `legend` + `probabilities` + `confidence`), **Noul** (yes/no → `noul` ∈ [0,1], **no confidence field**) |
| Parallelism | All questions in a request evaluated in parallel and in isolation against the same state; "adding questions barely changes the response time" |
| Latency | "Most queries complete in about 100 ms" (docs); full workflow cases at 0.3–0.5s on evals.typesafe.ai |
| Pricing | $0.042/Mtok input ($42/Btok); **output tokens free** |
| Limits | 64k tokens/request total; 32k for state + longest question; 250k tok/s and 1,200 req/min rate limits (dynamically adjusting); text-only input |
| Confidence | A statistic of distribution peakedness — for n options, `(n·peak − 1)/(n−1)`; flat distribution = low confidence; you can define your own from raw `probabilities` |
| Customization | No fine-tuning, no LoRA. Domain shaping happens entirely via request: state, instructions, criteria |

Primer claims verified as accurate. Two refinements worth building on:

1. **Noul has no confidence.** Uncertainty gating on yes/no questions must be interval-based (an "uncertain band," e.g. 0.4–0.6), which is exactly what the docs' own spam example does. The DSL must make this structural (§5.4).
2. **Jaggedness is a spec, not a footnote.** The nine documented failure modes of jev-1.13 — hyper-literal reading, no math/counting (it "recognizes the shape of an answer rather than tallying"), dates read as text not ordered quantities, indirection, context rot on large irrelevant state, adversarial content can steer it, contradictory instructions confuse it, structural invariants not guaranteed (a Noul and an equivalent yes/no Choice gave 0.22 vs 0.01/0.99 — don't mix forms of the same question), and no generation — are each a *lint rule* for question tables (§5.5). Also relevant: aliases move; the docs explicitly say to pin versioned IDs when you've tuned thresholds. The harness should enforce pinning.

**Framing correction.** The pitch frames the inversion as contrarian. Against the agent-loop orthodoxy, yes. Against TypeSafe, no: their entire "How to build" page is a manual for the inverted harness, and their three-architecture comparison (traditional software / LLM agents / "AI-powered software") places the target precisely. Jev literally cannot be an agent — it can't generate, so it can't write tool calls or plan prose. It can only *be* a control-flow brain. The open question is not whether the inversion works — TypeSafe's evals argue it does — but whether it deserves dedicated **tooling** or just ordinary code. That question organizes the rest of this document.

---

## 2. The loop

### 2.1 Three candidate shapes

| | Plain state machine (in-memory) | Event-sourced reducer | Durable workflow engine (Temporal/inngest/SFN) |
|---|---|---|---|
| Execution | Your code steps a graph | Your code folds events into state | Engine owns the loop; you write handlers |
| Persistence | None / ad hoc | Append-only event log is the state | Engine's internal history (Temporal: full event-sourced workflow history) |
| Crash recovery | Start over | Replay log, resume at last committed event | Automatic (deterministic replay, in Temporal's case) |
| Pause/resume (human) | DIY, fragile | Trivial: it's just an event | First-class (Temporal Signals; SFN `waitForTaskToken`; inngest events) |
| Timers/retries | DIY | DIY | First-class |
| Replay for *evals* | No | **Native — the whole point** | Partial (Temporal replay is for recovery, semantics-preserving; not designed for "re-run with a changed question table") |
| Determinism burden | None | Reducer must be pure; effects must be logged | Temporal: workflow code must be deterministic; side effects only in activities |
| Vendor coupling | None | None | Real |

### 2.2 Recommendation: event-sourced reducer core, pluggable durable shell

Take the reducer's semantics, and *don't write your own durable engine* — that's a solved, hard problem. Concretely:

**The core (a library, ~2k LOC):** A workflow is a compiled graph of nodes. The runtime executes nodes against a state and appends events to an append-only log:

```
Event ≈
  | { t: "node_started", node, stateHash }
  | { t: "ask_answered", node, model, stateSent, questionTableHash, answers, usage, latencyMs }
  | { t: "tool_result", node, idempotencyKey, input, output }
  | { t: "generated", node, model, prompt, output }        // the demoted LLM
  | { t: "escalation_opened", node, payload, assignee?, sla }
  | { t: "escalation_resolved", decision, by, at }
  | { t: "node_failed", node, error, attempt }
  | { t: "workflow_done", outcome }
```

`reduce(state, event) → state` is pure. Nodes are executed by an imperative shell that: asks Jev (speculative fan-out per node — one call per node, not per question), calls tools, calls the generative LLM, or opens escalations — and every result becomes an event before it influences the next transition. Writes to the log are the transaction boundary.

**The shell (three deployment tiers):**
- **MVP tier:** single process + Postgres/SQLite event table. Restart = reload log, resume. Good to ~10⁴ runs/day. This is the whole MVP (§7).
- **Production tier:** embed the reducer inside a **Temporal workflow** (each node = a Temporal activity; `ask_answered` events recorded via side-effect markers) or **inngest** step functions. The engine contributes what you shouldn't build: durable timers (SLA nudges for human escalations), retries with backoff (Jev 429s — rate limits are "adjusting dynamically" per the models page, so retries are not optional), worker scaling, heartbeats, versioning of *code*.
- **Serverless tier:** AWS Step Functions with `waitForTaskToken` for the escalation node — the callback-pattern map is exact: a Jev branch node = a Choice state + a Lambda making one `systemone` call; a human node = a task-token callback.

Why not Temporal *as* the core directly? Two reasons. First, Temporal's determinism constraints fight typed question tables: in Temporal, changing the workflow means new code versions and the dreaded "non-deterministic workflow history" errors; here, most changes are **data changes** (question wording, thresholds) that should replay cleanly against old logs, and the reducer makes that a first-class operation (§6). Second, the eval loop needs "re-run with modified questions," which is outside every durable engine's semantics. The reducer core gives you that; the engine gives you ops.

### 2.3 The human escalation node

This is the load-bearing feature of the whole architecture, because confidence-gated edges are only as safe as their escape valve. Mechanics:

1. Any gate miss (low confidence, or a high-stakes action without high confidence) routes to `escalate(reason)`, which appends `escalation_opened` with: the structured answer packet (every question, every probability, every confidence — not prose), the state snapshot reference, and the specific gate that failed.
2. The workflow parks. There is no thread to park in the reducer model — "parked" is simply: no further events until an `escalation_resolved` arrives via the resume API (`POST /runs/:id/resolve { decision }`). On the Temporal tier this is a Signal; on SFN, a task token; on inngest, an event.
3. The human's decision is itself an event — which means **escalations are replayable and evaluable**. "What would the human have done at this gate?" becomes ground truth for threshold tuning (§6). This closes the loop the docs only hint at ("route to a human" appears throughout TypeSafe's patterns, but nowhere is there a story for what the human's answer teaches the system).
4. SLAs are timers on the escalation: engine-native in production tiers; a `tick` event in the MVP tier.

### 2.4 Crash mid-workflow

Two cases, standard event-sourcing mechanics, with one Jev-specific twist:

- **Crash after event append:** nothing happened. Replay log, resume.
- **Crash between effect and event append** (the dangerous window: Jev answered but you died before recording; or a tool fired a side effect): the tool tier needs idempotency keys (as with any event-sourced system). The Jev tier is *benign* — the "effect" is a pure question, and re-asking costs ~$0.0001 and ~100ms. Jev is described as self-consistent ("stable answers across repeated evaluations"), so a re-ask should reproduce the answer; but don't rely on it — the log records `stateSent` and `questionTableHash`, so recovery can re-ask and flag any answer that differs from a partial record.
- **The twist:** because every ask is logged with its exact state and answers, "crash recovery" and "replay for evals" are the *same mechanism*. This is the architectural payoff of the reducer choice, and it's why the eval loop (§6) is cheap.

---

## 3. Prior art

### 3.1 Anthropic — "Building Effective Agents" (Dec 19, 2024)

The canonical taxonomy: **workflows** ("LLMs and tools orchestrated through predefined code paths") vs. **agents** ("LLMs dynamically direct their own processes"). Their guidance: "find the simplest solution possible, and only increasing complexity when needed"; workflows offer "predictability and consistency for well-defined tasks," agents win "where flexibility and model-driven decision-making [is] needed at scale" — their exemplars for agents being open-ended coding and computer use. The inverted harness is Anthropic's *workflows* category with two refinements: (a) even the routing decision is a calibrated, typed judgment rather than an LLM's chain-of-thought; (b) the LLM-in-a-loop portion is demoted from "orchestrator" to "leaf tool." Note Anthropic's own patterns map 1:1 onto Jev primitives: routing → Choice; parallelization (sectioning/voting) → parallel questions in one call (the API does the sectioning for you); evaluator-optimizer → Noul verifiers; prompt-chaining gates → confidence gates. Also relevant: their warning that frameworks "create extra layers of abstraction that obscure the underlying prompts" — the DSL below must avoid becoming that (hence: question tables are inspectable JSON, not opaque builder calls).

### 3.2 Cognition — "Don't Build Multi-Agents" (Jun 2025) + "Multi-Agents: What's Actually Working" (Apr 2026)

The 2025 essay's two principles — *share context* (full traces, not summaries) and *actions carry implicit decisions* (parallel writers conflict) — argued for single-threaded linear agents. The 2026 follow-up is the more important document for us: what works now is "**multiple agents contribute intelligence to a task while writes stay single-threaded**." Their two working patterns are strikingly instructive:

- **Clean-context reviewer:** Devin + Devin Review iterate; ~2 bugs/PR caught, 58% severe; best when the reviewer shares *no* context with the coder, because of context rot — "the math of attention." The inverted harness generalizes this: *every* Jev question is a clean-context judgment by construction (one state, no conversation history, no contamination from prior reasoning). Jev is the clean-context verifier as an API.
- **Smart-friend escalation:** a smaller model deciding when to consult a bigger one "wasn't good enough... knowing when to escalate... the quality ceiling was set by the primary." This is the strongest prior-art argument *for* the inversion: in the inverted harness, the escalation decision is not made by the weaker generative model improvising — it's a calibrated confidence gate in code. Cognition says knowing-when-to-ask is a training problem; the inverted harness says it's a routing problem you can buy for $0.0001.

Their rejection of "unstructured swarms" and endorsement of "map-reduce-and-manage" also matches: the fixed graph *is* the manager.

### 3.3 Simon Willison — agents as "tools in a loop to achieve a goal" (Sep 18, 2025)

Willison's settled definition: **"An LLM agent runs tools in a loop to achieve a goal."** By that definition the inverted harness contains **zero agents** — no LLM runs anything in a loop; the loop is code; the LLM (when present at all) is a tool that gets called. This is clarifying rather than damning: it means the debate isn't "agents vs. workflows" in the abstract, it's about *who holds the loop*. Willison's accountability argument (the 1979 IBM slide: "a computer can never be held accountable; therefore a computer must never make a management decision") maps neatly onto confidence-gated edges: the system's answerable unit is the gate policy, which is diffable, reviewable, and owned by a human — precisely the property an agent's emergent behavior lacks.

### 3.4 LangGraph (closest existing tool)

LangGraph already delivers: graph-as-code, checkpointers (persistence), `interrupt()` for human-in-the-loop, and time-travel (replay from any checkpoint). If you want the inverted harness *today*, the fastest path is a LangGraph library. What LangGraph does **not** give you, and what motivates this design: nodes are opaque LLM calls with untyped outputs; there is no notion of a *question table* as a versioned artifact; no diffing of decision surfaces; no probability/confidence-aware edges; no reference-probability eval loop. LangGraph solves "graph + persistence"; the inverted harness's delta is "typed decision surfaces + governance of what they say." (Verified only up to the docs' redirect to docs.langchain.com; feature claims from training knowledge.)

### 3.5 Durable engines (Temporal / inngest / Step Functions)

Their role here is substrate: timers, retries, signals, heartbeats, visibility. Temporal's event-sourced history and deterministic replay are the intellectual ancestor of the reducer core; SFN's `waitForTaskToken` is the canonical managed pause/resume; inngest is the lightest-weight option for event-driven trigger → steps → sleep → resume. None of them know anything about questions, calibration, or thresholds — nor should they. **Positioning: the inverted harness is a library layered on one of these, never a competing engine.**

### 3.6 Prefect / Dagster

Durable orchestration for "data, ML, and agents" (Prefect's own tagline) — plain-Python `@flow` functions, retries, caching, observability; Prefect also maintains FastMCP and (notably) **acquired Dagster Labs in July 2026**, consolidating the orchestration layer. Relevant for two reasons: (a) they confirm the market wants *durable execution with LLM calls inside*, i.e., the harness's execution tier is commoditized; (b) neither has any opinion about what happens inside a node — an LLM call inside a Prefect task is just as opaque as anywhere else. The inverted harness's value is entirely in the *node semantics*, which orchestrators deliberately don't touch. An adapter tier (workflow compiled to a Prefect flow) is plausible for data-platform teams but is not the interesting part.

### 3.7 TypeSafe's own workflow evals (evals.typesafe.ai) — the empirical case

Method: decompose four tasks (security incidents, agent-trace observability, invoice processing, customer service) into programmatic rules + typed questions; **assume the harness is correct**; generate reference labels from "an average of the responses of GPT-6 Astra and Claude Fable 5.1, both at high thinking, answering every question in the harness." Results: workflow > prompt for essentially every model on accuracy, cost, and time simultaneously. Jev: 67.8% mean accuracy at $0.0004/case, 0.4s. Customer service: Jev workflow 76.0% — within noise of sol (78.3%, $0.0323, 10.1s) at ~300× lower cost. Security incidents: Jev 61.7% at $0.0001 vs. Haiku-4.5-prompt 17.1%.

**The honest counterexamples:** DS v4 flash on security incidents got *worse* as a workflow (37.9% vs. 44.6% as a prompt), and DS v4 pro on agent-trace observability ticked down (71.6% vs. 72.1%). Structure is not magic; it hard-codes the harness author's decomposition, and a wrong decomposition can hurt. This is the strongest argument for the eval-and-replay tooling in §6: the harness is an artifact that can be *wrong*, so it must be *testable*.

### 3.8 Synthesis: when fixed graphs win, and where they break

**Fixed graphs win when:**
1. The decision vocabulary is enumerable and stable (route / escalate / retry / accept / stop — or 255 teams, or 4 severity levels). If you can write the options down, Jev can choose among them with calibrated confidence.
2. Judgments are *per-item* and *context-bounded* — each decision needs a slice of state, not an evolving plan. Jev's isolation-per-question is a feature here.
3. Latency and cost are on the critical path (100ms and ~$0.0001/decision beats an agent turn by 2–3 orders of magnitude).
4. Auditability is a requirement, not a nicety — probabilities and confidences in a log are an auditor's dream.
5. Errors are recoverable and risk is scalable per action — the confidence-gated, risk-scaled threshold pattern (auto at 0.7 for cheap actions, 0.85+ for destructive ones, human otherwise).

**They break when:**
1. The *shape* of the task is input-dependent — Anthropic's orchestrator-workers exists precisely because "the number of files to be changed and the nature of the change in each file likely depend on the task." You cannot enumerate the graph for "fix this bug."
2. State must be discovered interactively — the next question depends on what you just learned *and requires new state to be fetched*, repeatedly. Jev supports two-step dependencies but the docs are explicit: "Two requests are the exception, not the rule."
3. Generation *is* the task.
4. The graph goes stale silently — workflows fail by accumulating `other` answers and full human-escalation queues. This is the brittleness objection, and the only real answer is operational: measure `other`-rate and escalation-rate as first-class metrics (§6), because both are the graph telling you it doesn't cover the world anymore.

---

## 4. Domain fit

### 4.1 WIN: CI failure triage

**Why it wins:**
- **Inputs are bounded text**: failing test names, log slices, the diff, flaky-test history. Context rot is manageable because a *code* prefilter (extract failing section, last N lines, test history) does the trimming — the jaggedness doc's own prescription ("filter first; send only what the question needs").
- **Decisions are enumerable**: failure class (flaky / regression / infra / needs-info / other), owner team (Choice, up to 255 options — or a beam search through the org tree per the hierarchical-classification cookbook, where beam K=3 beat greedy 4/4 vs. 2/4 on expected leaves), severity (Score), security relevance (Noul), auto-retry safety (Noul).
- **Math and dates stay in code**, per jaggedness rules: retry counts, timing deltas, "did this test pass on main yesterday" — all computed; Jev only judges the semantic residue ("does this stack trace look like the known infra flake?").
- **Risk scaling is natural**: auto-retry is cheap (gate at 0.7), auto-close-known-infra is cheap-ish (0.7 + link), paging an on-call is expensive (gate at 0.85 or escalate), anything security-adjacent escalates on any doubt.
- **The empirical prior**: TypeSafe's security-incident workflow is the nearest cousin — Jev 61.7% at $0.0001/case in 0.3s.
- **Speculative fan-out is perfect here**: one call asks all ~8 questions against one filtered state; irrelevant answers (the severity answer for a ticket that turns out to be infra) are ignored by code.
- **Cost/latency arithmetic**: ~3k tokens of state + 8 questions ≈ $0.00013 per triage. A nightly CI fleet of 500 failures costs ~$0.07/day for judgment. The generative summary (the one LLM call) will cost more than every decision combined.

### 4.2 WIN: Alert/incident routing

Closest to TypeSafe's own agent-trace-observability (Jev 71.6%, $0.0003, 0.5s) and security-incident workflows. The decision surface is exactly the inverted harness's shape: given (alert, machine inventory, recent deploys, on-call roster), choose {page / queue / close / merge / contain} — where **contain** is destructive and gets a 0.85+ gate with mandatory human below it, and **close** is cheap and gates at 0.6. Team routing through the org tree uses the beam-search pattern. Dedup/merge ("is this alert the same incident as any of these 5 open ones?") is one Noul per candidate pair, batched in one call — the "count in code, judge in model" pattern from the jaggedness page. Human escalation lands in the on-call's queue *with the full probability packet attached*, so the human sees not just "Jev thinks it's page-worthy" but "0.62 page / 0.31 queue, confidence 0.44" — and their resolution becomes training signal (§6). The escalation path is also the answer to the alert-fatigue objection: a mis-routed page costs a human's sleep, which is precisely why risk-scaled gates + escalation exist here and not in a free-form agent.

### 4.3 WIN: Moderation pipelines

High volume, enumerable categories, explicit harm rubrics, and an existing human-review tier that the confidence gates plug straight into. TypeSafe ships three cookbooks that are literally this domain (self-consistency for moderation choices, LLM guardrails, classification-with-confidence for 75 industry groups). The distinctive fit: **Noul's lack of a confidence field is handled the way the docs' own spam example handles it** — decompose into atomic nouls (requests-credentials, unexpected-reward, time-pressure, sender-mismatch), weight them in code, and treat the *combined score's* uncertain band (0.4–0.6) as the human-review trigger. Appeals are free: the event log shows exactly which question pushed the item over the line. Note the jaggedness caveat honestly: adversarial content can steer Jev (#6), and moderation is the most adversarial domain of the three — mitigations are precise criteria, structured option descriptions with `not_for` fields, and adversarial test suites in the eval loop (§6), not faith in calibration.

### 4.4 Honorable mention: ETL with judgment steps

Entity alignment (two catalogues, "is pair (a,b) the same product?") is the cleanest single example in the entire corpus: the entity-alignment cookbook uses one Score question whose three levels *are* the three available actions — merge / leave unlinked / hand to curator — "there is no threshold to fit." When a rubric's levels map 1:1 onto actions, the confidence gate is doing all the work and the graph is three nodes. This is the shape to reach for in data-quality, dedup, and ingestion-judgment pipelines.

### 4.5 LOSS: open-ended coding

The mandated losing domain, and it loses for structural reasons, not model-quality reasons:
1. **Unenumerable graph.** The next step depends on what the agent just learned from running a test, which depends on the code, which depends on the task. Anthropic's orchestrator-workers pattern exists for exactly this; there is no fixed node vocabulary.
2. **Jev can't generate code** — jaggedness #9 is explicit: forced generation via chained choices "will not work well and will be very slow."
3. **Jev can't do the parts of coding that look like judgment but are actually math**: counting occurrences, date arithmetic in tests, numeric comparisons — the exact failures the jaggedness page documents.
4. **Context rot vs. codebases**: a repo slice blows past the 32k state budget, and relevant detail can't be enumerated a priori.

**The nuance worth keeping:** even inside a coding agent, the inverted harness governs the *meta*-decisions — Cognition's "smart friend" problem ("how does a dumber model know it's at its limits?") is a routing problem: route-to-stronger-model / stop-and-ask-human / proceed can be a Choice with a confidence gate, evaluated over the agent's recent trace (which is what the agent-trace-observability eval already is). So: coding loses as a *domain*, but the harness still wins the *supervision* layer around a coding agent — the agent becomes the tool node.

---

## 5. The DSL

### 5.1 Design principles

1. **Questions, thresholds, and edges are data** (serializable, content-hashed, diffable). **Node bodies are code**, referenced by hash. A workflow version = `{ graph, questionTables, policy, modelPin }`.
2. **One Jev call per ask-node**, exploiting speculative fan-out — the DSL should make asking one question at a time *awkward* (the docs even ship an agent skill to stop coding agents from doing this).
3. **The generative LLM appears only as `generate()`** — a tool node with a schema, never a coordinator.
4. **Effects are events**; replay never re-fires them by default.
5. **Jaggedness rules are lint rules**, not code-review folklore.

### 5.2 TypeScript sketch

```ts
// questions/classify.ts — the question table is DATA
import { choice, noul, score, table } from "@inverted/core";

export const classifyFailure = table({
  failure_class: choice({
    instructions: "What kind of CI failure does `log` show, given `diff` and `history`?",
    criteria: {
      flaky_test:  { what: "The failing test passed recently on the same code",
                     not_for: "Failures caused by the diff under test",
                     examples: ["Same test green on main 2h ago, red here"] },
      regression:  "The diff under test broke behavior the tests verify",
      infra:       "Runner, network, dependency-fetch, or CI platform problems",
      needs_info:  "The log does not contain enough to decide",
      other:       "None of the above",
    },
  }),
  security_relevant: noul({
    instructions: "Does `diff` or `log` involve authentication, cryptography, secrets, or permissions?",
    criteria: { true_: "Touches or exposes one of those areas",
                false: "No security-sensitive surface involved" },
  }),
  determinism: score({
    instructions: "How deterministic does `log` make this failure look?",
    criteria: [
      "Intermittent, order-dependent, or timing-sensitive",
      "Probably deterministic",
      "Clearly deterministic: same input, same failure",
    ],
  }),
  // ...retry_safety, owner_team, known_flake_match (one noul per history entry), ...
});

// workflows/ci-triage.ts
import { workflow, ask, branch, generate, run, escalate } from "@inverted/core";
import { classifyFailure } from "../questions/classify";

export const ciTriage = workflow("ci-triage", { model: "jev-1.13.0" })  // pin, never alias
  .input<BuildFailure>()
  .code("prefilter", async (f) => ({                 // deterministic code: extraction, math, dates
    ...f,
    failing: extractFailingSection(f.log),
    history: await flakyHistory(f.testFiles),        // tool call, idempotency-keyed
    elapsedMs: f.failedAt - f.startedAt,             // date arithmetic stays HERE
  }))
  .ask("classify", {
    state: (s) => ({ log: s.failing, diff: s.diff, history: s.history }),  // context-rot guard: minimal state
    questions: classifyFailure,
  })
  .branch("route", (s, p) => {                       // p = policy, loaded from data
    const c = s.classify.failure_class;
    return branch(c, {
      flaky_test:  p.retry  .when(s, a => a.confidence >= 0.70 && s.prefilter.retries < 1, "retry"),
      infra:       p.close  .when(s, a => a.confidence >= 0.70, "close_known_infra"),
      regression:  p.page   .when(s, a => a.confidence >= 0.85
                                     && s.classify.determinism.score > 1, "page_owner"),
      otherwise:   escalate("human-triage", { packet: s.classify }),
    });
  })
  .code("retry",  (s) => requeueBuild(s.input.buildId))
  .code("close",  (s) => closeWithReference(s.input.pr, s.classify))
  .code("page",   (s) => pageOncall(s.classify.owner_team.choice, s.classify))
  .generate("summary", {                             // the ONE generative call — a leaf, not a brain
    model: "claude-haiku-4.5",
    input: (s) => triagePacket(s),                   // structured render of state + answers
    output: z.object({ comment: z.string() }),
  })
  .code("post", (s) => postComment(s.input.pr, s.summary.comment))
  .escalation("human-triage", {
    resumeWith: z.object({ action: z.enum(["retry","close","page","discard"]) }),
    onTimeout: "1h",                                 // engine-native timer in prod tiers
  })
  .build();
```

### 5.3 Policy as data (thresholds are not code)

```json
{
  "version": 3,
  "model": "jev-1.13.0",
  "gates": {
    "retry":          { "on": "failure_class=flaky_test", "minConfidence": 0.70 },
    "close":          { "on": "failure_class=infra",      "minConfidence": 0.70 },
    "page":           { "on": "failure_class=regression", "minConfidence": 0.85,
                        "requires": "determinism.score > 1" },
    "security":       { "on": "security_relevant",        "noulBand": [0.30, 1.01], "action": "escalate" }
  }
}
```

Because thresholds live in data, they can be grid-searched **offline against the event log** with zero API calls (§6.4) — this is the single highest-leverage decision in the DSL, because threshold tuning is the most frequent change and the one that most wants a regression suite.

### 5.4 Handling Noul's missing confidence

Nouls gate on **bands**, not thresholds — mirroring the docs' spam example. `noulBand: [0.30, 1.01]` above means: below 0.30 → treat as no; in-band → the action fires only alongside corroborating gates; a mid-band noul driving a *solo* decision routes to escalate. The DSL's `branch` should reject a bare threshold on a noul without an explicit band — make the docs' guidance structural.

### 5.5 Versioning and diffing question tables

Each question gets a content hash over its canonical JSON (`instructions`, `criteria` including option keys, order — order is part of the question per the hierarchical-classification cookbook's note that "sibling options are asked in the order they appear"). Diffing operates on that:

```
$ inverted diff questions/classify@v2 questions/classify@v3
~ failure_class.instructions   wording changed          [re-ask on replay]
~ failure_class.criteria.regression  description rewritten [re-ask]
= security_relevant            unchanged                [reuse recorded answers]
+ retry_safety                 new question             [re-ask]
- legacy_flake                 removed                  [ok]
```

Rules:
- **Unchanged question + unchanged state + same model pin → reuse the recorded answer** on replay. Jev's self-consistency makes this faithful.
- **Changed question → re-ask against the recorded state** (a live call, ~$0.0001). This is what makes the eval loop cheap: you never re-fetch tools, never re-run side effects.
- **Changed model pin (jev-1.13.0 → jev-1.14.0) → re-ask everything** (that's the point of the pin).
- Structural checks on every release: option count ≤ 255; state selector's output ≤ 32k tokens; no two questions that are semantic negations of each other (the Noul/Choice-invariant trap); instructions don't ask for counts, arithmetic, or date ordering (jaggedness #2/#3); criteria don't contradict instructions (#7).

That last bullet is the **jaggedness linter** — nine documented failure modes turned into CI checks on question tables. It's the kind of thing a harness can do that inline code never will, because the linter needs the table *as data*.

### 5.6 Visualization

Free from the event log: a graph view with per-edge traffic, per-question distributions (the confidence explorer from the docs, but over your production answers), confidence-vs-outcome calibration plots per question, `other`-rate and escalation-rate time series. The hierarchical-classification cookbook already demonstrates the diagnostic value of seeing *which node* misfires; that becomes a dashboard, not a notebook.

---

## 6. The eval loop

### 6.1 What's recorded

Every ask-event already carries: exact state sent, question-table hash, per-question answers with full probability distributions and confidences, model version, tokens, latency. Every escalation carries the packet and (once resolved) the human's decision. Every effect carries its outcome. This is the training corpus; no separate telemetry needed.

### 6.2 Reference probabilities (TypeSafe's method, adopted and adapted)

For a golden set of states (sampled from production, plus adversarial cases), generate reference answers by **averaging frontier models** — TypeSafe uses GPT-6 Astra + Claude Fable 5.1 at high thinking, "answering every question in the harness." Your candidate is either a new question-table version or a new Jev version. Metrics, in descending order of actionability:

- **Threshold-crossing rate**: how often a probability moves across a gate's threshold between candidate and reference. This is *the* metric — a probability moving 0.72→0.68 is noise; a probability moving across your 0.70 gate is a behavior change.
- **Top-1 agreement** (choices), **level agreement** (scores), **absolute probability error / KL** (distributions, nouls).
- **Confidence–agreement calibration**: when Jev says confidence 0.9, how often does it agree with reference? (Plots confidence vs. accuracy — the docs' own recommended method for threshold-setting, now mechanized.)
- **Workflow-level**: decision flip rate on full replay (§6.3), escalation-rate delta, `other`-rate delta, end-outcome accuracy where you have ground truth (human resolutions!).

### 6.3 Replay: recorded workflow × new question table

```
$ inverted replay --runs 'last_7d' --table questions/classify@v4 --policy policy@v4
  1,204 runs replayed
  re-asked  2 questions/run avg (changed since recording)   → 41,818 live Jev calls, $0.006, 6 min
  reused    6 questions/run avg (unchanged)
  effects   suppressed (decision-diff mode)

  decisions: 1,171 unchanged · 26 flipped · 7 no-longer-reachable
  escalations: 143 → 131 (−12; flaky_test gate now catches 9 old humans + 3 closes)
  flips by node: route 24 · post 2
  inspect: inverted replay --show run:9f3c --why   (prints both answer sets side by side)
```

Mechanics: walk the event log; code nodes re-execute *only if marked pure* (side-effectful nodes reuse recorded outputs); ask nodes reuse or re-ask per the diff rules (§5.5); effects are suppressed by default (`--apply` for shadow execution into a staging sink). Because re-asks use recorded states, replay is deterministic in inputs and comparable in outputs. **Ship gate for a question-table release:** flip rate below team-chosen tolerance on a golden set + escalation-rate delta reviewed + no regression on adversarial suite. Same machinery, pointed at a *model* pin change instead, is your jev-1.14 migration test.

### 6.4 Threshold tuning, offline

Because gates are data and answers are logged, sweeping a threshold is pure computation over the log. For each historical run you know the full answer distributions and the eventual outcome (human resolution, or downstream signal — did the auto-retry actually pass?). Grid-search gate thresholds to maximize agreement-with-outcome at an escalation budget, not raw accuracy: the tradeoff curve (automation rate vs. error rate at each confidence level) is the artifact you show stakeholders, and per the docs' guidance ("start conservative, test with your own data, adjust as you observe") this is that advice, mechanized.

### 6.5 The eval of the harness itself

TypeSafe's "assume the harness is correct" is a benchmark convention, not reality (§3.7's counterexamples). The loop must be able to indict the *decomposition*: if a question shows uniformly low confidence against reference, or an `other`-rate trend line climbs, the fix is a new question or new options — which is a diffable table change, evaluated by the same replay machinery. Human escalations are the richest source: every resolved escalation is a labeled example of "the graph was wrong here," and the eval loop should mine them into the golden set automatically.

---

## 7. MVP: the CI-triage bot

**Goal: make the inversion vivid — one generative LLM call, everything else is Jev + code, and the demo shows crash-resume, replay, and a question-table diff flipping decisions.**

**Trigger:** GitHub Actions `check_run` failure webhook → `workflow.run()`.

**Nodes (7 total, 1 Jev call, 1 LLM call):**

1. `prefilter` (code): fetch job log, diff, flaky history; extract failing section; compute retry count, elapsed, "same test failed on main in last 7d?" — all math/dates here.
2. `classify` (**one Jev call**, speculative fan-out, ~8 questions): `failure_class` (Choice ×5), `security_relevant` (Noul), `determinism` (Score ×3), `retry_safety` (Noul), `known_flake_match` (Noul per history entry), `owner_team` (Choice over teams — or beam search if the org tree is deep).
3. `route` (code, policy-driven gates): auto-retry (flaky, conf ≥ 0.70, retries < 1) / close-known-infra (conf ≥ 0.70) / page owner (regression, conf ≥ 0.85, determinism > 1) / escalate.
4. `retry` / `close` / `page` (code, idempotency-keyed).
5. `escalate` (human node): GitHub issue on the triage board with the full probability packet; 1h timer; human picks retry/close/page/discard → resume event.
6. `summary` (**the one generative call**): Haiku-class model renders the structured packet into the PR comment. Schema-validated output; recorded as a `generated` event.
7. `post` (code).

**Expected economics:** state ~3k tokens + 8 questions ≈ **$0.00013 + ~150–300ms** for the entire decision layer, per failure. 500 failures/day ≈ **$0.07/day**; the single summary call per failure will cost ~10–100× all judgments combined — which is exactly the demo's rhetorical point.

**The demo script (this is what makes it land):**
1. Run on a real flaky failure → watch one Jev call answer 8 questions; watch the gate logic print its reasoning (each edge logs `flaky_test p=0.88 conf=0.81 ≥ 0.70 → retry`).
2. `kill -9` the process mid-`classify`; restart; watch it resume from the log with zero re-asks.
3. Tweak one question's wording (`failure_class.criteria.regression`), run `replay --runs yesterday`: "3 of 214 decisions flipped; 2 escalations resolved to auto." That 30-second moment — a prompt change with a regression suite — is the pitch.
4. Open a human escalation, resolve it, and watch tomorrow's golden set grow by one labeled example.

**Stack for the MVP:** the reducer core + Postgres event table + GitHub API + `@typesafe-ai/sdk`. No Temporal, no LangGraph, no queue — a single container. Total: a weekend of code plus a week of question-table iteration, most of which the replay loop accelerates.

---

## 8. Skeptic's corner

### 8.1 When this is overkill — just call Jev inline

- **One or two branch points.** A single route-then-handle decision is 20 lines of Python with the SDK, exactly as the docs show. The harness's machinery (event log, diffing, policy files) is more code than the problem. Rule of thumb: the harness starts paying at **3+ gates, or the first compliance audit, or the second person who wants to change a threshold**.
- **Exploratory phase.** While you're still discovering what the questions should be, graph-and-table ceremony slows iteration. The docs' inline style is a better lab bench. Migrate into the harness when the question set stabilizes — the event log you *wish* you had starts on day one, so instrument the inline version early (record every call; it's the same event schema).
- **Jev's economics make "batching" a non-argument.** Be honest: parallel-in-one-call is an *API* property, not a harness property. Anyone citing "amortization" as the harness's value is wrong. $0.042/Mtok in, free out, 100ms — inline Jev is already nearly free. **The harness's value is not cost or speed. It is governance.**
- **You already have a durable workflow engine and your team knows it.** Then the right move is the question-table + policy + replay *tooling* as a library inside your existing engine (§2.2's positioning), not this-or-any harness as a platform.

### 8.2 What the harness actually adds (priced honestly)

| Capability | Without harness (inline Jev) | With harness | Honest value |
|---|---|---|---|
| **Replay** | Re-run scripts against saved states, DIY | Native; reuse-vs-re-ask per diff | High — it's the substrate of everything below |
| **Versioning/diffing** | Questions live in code; prompt changes ride along in PRs of code | Question tables as artifacts; semantic diff; ship gates | High for teams, nil for solo |
| **Evals** | Ad hoc notebooks | Reference probabilities, calibration, flip-rate gates, escalation mining | High — this is where correctness lives |
| **Visualization** | Logs | Graph + distributions + `other`-rate dashboards | Medium-high; debuggability of *decompositions* is genuinely new |
| **Safety structure** | Discipline ("remember to gate destructive actions") | Risk-scaled gates enforced by the DSL; noul bands required; jaggedness linter | High in regulated/hostile domains |
| **Human escalation** | Build a queue, twice, badly | First-class pause/resume with probability packets; resolutions feed evals | High — this is the part everyone under-builds |

### 8.3 Where the idea itself can fail

1. **A bad harness is worse than a prompt** (the DS-v4-flash lesson). The decomposition hard-codes someone's understanding; if it's wrong at scale, you've industrialized the error. Mitigation is cultural: the eval loop must be empowered to reject the harness author's own table — including TypeSafe's assumption that "harness is correct" belongs in benchmarks only.
2. **Adversarial steering** (jaggedness #6) is not fixed by structure. A judge that can be steered by content it's judging is steerable inside a nice graph too. Moderation pipelines need adversarial test suites and possibly defense-in-depth (regex/code checks for the mechanical parts — which the "count in code" pattern pushes you toward anyway).
3. **Context rot vs. rich domains.** Any domain where the needed context is large and non-filterable (big traces, long threads) will fight the 32k state budget; the harness's minimal-state selectors help, but some judgment genuinely needs 200k tokens of *relevant* material — that's a generative-model job, and the harness should route it there rather than pretend.
4. **Static-graph rot.** `other`-rate creep and a slowly filling human queue are the failure signature. If nobody owns those dashboards, the harness degrades into an expensive `if` statement with an escalation button.
5. **Vendor concentration.** The whole design leans on Jev's specific properties (calibration, parallel isolation, self-consistency, pricing). A second System-One provider or a Jev regression changes the calculus — mitigate with model pinning, replay-based migration tests (§6.3), and keeping the generative tier pluggable.
6. **Build-vs-buy gravity.** LangGraph gives you ~60% (graph, checkpoints, interrupts, time-travel) today. If you build the inverted harness as anything more than a library on LangGraph or a Temporal SDK, you're rebuilding durable execution — don't. The defensible novelty is exactly the typed-question-table layer: diffing, reference-probability evals, jaggedness linting, escalation-as-training-data.

---

## 9. Open questions

1. **Do question tables want to be code or data?** This design says data (diffing, non-engineer tuning), but TypeScript authors will want typed literals with the ergonomics of code. The `table()` + `satisfies` sketch tries to have both; needs real-world validation.
2. **Who owns the policy?** If ops tunes thresholds via PRs to `policy.json`, you get auditability but slow loops; if there's a UI, you get speed and a governance question. The escalation-mining loop (§6.5) suggests a weekly "tuning PR" generated automatically, humans approving diffs — replays attached.
3. **Can escalations train a threshold optimizer safely?** Human resolutions are biased ground truth (humans see only low-confidence cases — a selection effect the tuner must correct for).
4. **Multi-workflow organization.** When you have 12 harnesses, do question tables get shared/inheritance (a common `security_relevant` question with domain-specific criteria overlays)? The function-calling cookbook's `spec.json` suggests yes; the versioning model needs a story for shared tables.
5. **The 255-option ceiling and the beam pattern.** Team routing past ~255 teams requires hierarchical Choice with beam search as a *node type* — worth shipping as a built-in `beam()` node given the cookbook's greedy-vs-beam gap (2/4 → 4/4).

---

**One-paragraph verdict.** The inverted harness is the right architecture for a specific and large class of systems — enumerable decisions, bounded context, risk-scaled actions, humans in the loop — and Jev's primitives (parallel typed judgments, calibrated confidence, ~$0.0001/decision) make it economically inevitable for those systems. It is not a general agent replacement, and its value over inline Jev calls is not speed or cost but *governance*: replay, diffing, evals, and structural safety. Build it as a library on an existing durable engine, make the question table the primary artifact, treat the jaggedness list as a linter spec, and let every human escalation become training data. Start with the CI-triage bot — one LLM call, eight questions, and a `kill -9` recovery — and see whether the replay moment sells itself.
