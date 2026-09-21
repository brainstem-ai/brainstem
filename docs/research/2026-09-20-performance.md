# Brainstem Performance Analysis — Reflex Engine & Harness

**Date:** 2026-09-20. Codebase at commit `2dd5680` (post Phase 1 MVP: gate/sanitize/verify/pulse/steer wired into the pi-agent-core loop, replay CLI landed).

**Scope:** `packages/core` (reflex engine) and its consumption by `packages/cli` (harness). Goal: reduce perceived and absolute latency of the reflex layer. Cost is a secondary concern — Phase 0 measured $0.00008/step, i.e. reflexes are already nearly free.

---

## 0. The performance model: it's all network, zero CPU

Verified end-to-end by reading the full core + harness + the pi-agent-core loop and the `@typesafe-ai/sdk` bundle:

- `decide*` functions, `floor.ts` regexes, question builders, `mapAnswers` — all microsecond-scale. **There is no CPU bottleneck anywhere in the core.** Porting anything here to WASM/native would be pure waste.
- The entire performance question is **Jev round-trips**: how many per turn, and whether they sit on the agent loop's critical path.
- Phase 0 (experiment 03) measured one batched call: **p50 195ms, p95 419ms** (23 questions, 1.9k input tokens). That number is the unit of currency for everything below.

## 1. The engine abandoned the Phase 0 batching design — ~3–4 round-trips per turn

Experiment 03 validated the core economic claim: **23 questions in ONE call ≈ 195ms** ("adding questions barely changes response time"). The implementation diverged into per-reflex calls:

| Hook (`packages/cli/src/harness.ts`) | Reflex | Calls | Blocks |
|---|---|---|---|
| `routedStreamFn` | steer | 1 **per model call** (every continuation) | first token of LLM response |
| `beforeToolCall` | gate | 1 per bash/write | tool execution |
| `afterToolCall` | sanitize+verify | 1 per tool result | **tool result entering context** |
| `shouldStopAfterTurn` | pulse | 1 per 3 turns | next turn start |

Verified in `pi-agent-core/dist/agent-loop.js`: `finalizeExecutedToolCall` awaits `afterToolCall` **before** the tool-result message is created and appended — sanitize sits squarely on the critical path. `prepareToolCall` awaits `beforeToolCall` before execution — same for gate.

**Arithmetic:** a turn with 2 tool calls ≈ 6 serialized round-trips ≈ 1.2–2.5s of pure added latency. A 10-tool task adds ~6s.

**Fix — the original design:** one batched ask per loop step. At assistant `message_end` the harness knows the pending action (gate), the recent events (pulse/steer) — fire a single `gate+pulse+steer` call whose answers arrive before the decision points that need them. Sanitize stays per-tool-result (its input doesn't exist earlier — but see §6.1).

## 2. Steer is the worst single offender

`engine.steer()` fires before **every** `streamFn` invocation — including mid-turn continuations after each tool result — delaying every first token by ~200ms to choose mini vs. frontier. Its inputs (`task`, last-8 events) barely change between continuations of the same turn. Folding it into the turn-boundary batch (§1) eliminates it as a separate call; memoization (§3) is the stopgap.

## 3. Zero memoization of a self-consistent model

Jev is documented as self-consistent: same state + same questions + same model pin ⇒ same answer. Today, running `npm test` five times while debugging = five identical gate calls, five identical round-trips.

**Fix:** content-hash cache keyed on `stableStringify(model, state, questions)` → answers. Two force multipliers:

- The journal already records every `(state, questions, answers)` triple — **seed the in-memory cache from the journal at startup** and repeat asks are free even across sessions.
- The new `packages/cli/src/replay.ts` already proves recorded answers are reusable artifacts. The cache invalidation policy is the research doc's §5.5 diff rule: *unchanged question + unchanged state + same pin → reuse*.

## 4. No latency bounds: worst case per reflex is ~30 seconds

SDK defaults (read from `node_modules/@typesafe-ai/sdk/dist/index.mjs`): timeout **10s** (`config.timeout ?? 1e4`), retries **2** with 500ms→5s backoff on 408/429/5xx. A rate-limited reflex therefore blocks the loop for up to 10s × 3 attempts + backoffs ≈ **30s+**.

For a reflex layer this is backwards: a missing answer has a safe degradation (gate→ask, sanitize→review, steer→frontier, pulse→continue).

**Fix:** per-call `timeout` (~1.5s, supported via per-call `options.timeout`) + a circuit breaker failing to policy-defined safe defaults. Converts unbounded tail latency into occasional user prompts — exactly the trade the architecture exists to make.

## 5. Journal I/O is synchronous and duplicated on the critical path

`packages/core/src/journal.ts`:

- Every reflex triggers **two** `appendFileSync` calls (`recordReflex` + `recordDecision` in `engine.ts`).
- Every append re-runs `mkdirSync(dirname(path))` — a wasted syscall per event.
- Sync fs I/O blocks Bun's event loop mid-turn.
- Each reflex event stores full `state + questions + result`; question tables are static text repeated verbatim on every event.

**Fix:** open one buffered sink at session start (`mkdir` once), async flush on interval/exit, and store `questionTableHash` + answers instead of full question bodies. This is exactly the event schema the inverted-harness research doc already specifies (§2.2, `ask_answered` event: `stateSent`, `questionTableHash`). Smaller journals also speed up `loadJournal` and replay.

## 6. Radical tier

### 6.1 Gate prefetch via the event stream

`beforeToolCall` fires at execution time, but a tool call's name and args are known the moment the assistant message finishes streaming — often seconds earlier. `agent.subscribe` already exists in the harness. Watch for completed tool calls, start `engine.gate()` immediately, memoize the in-flight promise by args-hash; `beforeToolCall` awaits the warm promise. Gate latency ~fully hidden. (Verify whether pi's event stream exposes tool-call completion distinctly from `message_end`; worst case prefetch at `message_end`.)

### 6.2 Optimistic sanitize with retroactive enforcement

Sanitize blocks context insertion only because of pi's hook contract. Radical version: return the raw result immediately, fire sanitize in background, enforce at the *next* `beforeToolCall` — on "block", block the action and inject a steering message. Hides sanitize's ~200ms entirely, but is a **real security regression**: adversarial content sits in context for one turn — the exact attack sanitize exists to stop. High-trust-dial mode only. The safer 80%: cache + trimmed state + §1 batching, keeping blocking semantics.

### 6.3 Distill the gate to a local model

Assets on hand: the labeled 58-command Phase 0 corpus, plus an ever-growing journal of (command → disposition) pairs — a training set that grows every session. A tiny local classifier (small fine-tuned model, or embeddings + kNN over the corpus) answers in <5ms; Jev sees only cache-misses/novel commands. The static floor stays as backstop. Long-term endgame for the gate: network latency → memory latency.

### 6.4 Cross-session reflex cache as a content-addressed store

Journal = cache = training corpus. Make it one artifact: an append-only store keyed by `hash(model, questionTableHash, state)`. Replay, threshold tuning, memoization, and distillation (§6.3) all read from the same thing.

### 6.5 Merge gates for parallel tool calls

pi supports parallel tool execution (`executeToolCallsParallel` in agent-loop.js). When the model emits 3 bash calls at once, those are 3 independent gate asks today. One call, 3× the gate questions.

### 6.6 Connection warm-up at startup

First-call TLS+RTT to `api.typesafe.ai` is a chunk of the 195ms p50. Fire a trivial ping at harness boot so the first real gate isn't cold. One line, small but free.

## 7. What NOT to touch

- `decide*` functions, `floor.ts` regexes, question builders, `mapAnswers` — all µs. No WASM, no native ports.
- `summarizeMessages`, `textOf`, `summary()` in the harness — fine.
- The 8000-char content cap in `afterToolCall` — already right-sized for Jev's 32k state budget.

## 8. Suggested sequence (latency saved per line of code)

| # | Item | Effort | Effect |
|---|---|---|---|
| 1 | Per-call timeout + circuit breaker + safe defaults (§4) | small | fixes 30s worst case |
| 2 | Memo cache on (model, state, questions), journal-seeded (§3) | medium | kills all repeat latency **and** cost |
| 3 | Turn-boundary batch: one ask = gate(pending)+pulse+steer (§1, §2) | medium — engine API change; add `engine.step()`, keep existing methods as wrappers | 3–4 calls/turn → ~1–2 |
| 4 | Journal: buffered async sink + question-hash references (§5) | small | unblocks event loop, shrinks logs |
| 5 | Gate prefetch via subscribe (§6.1) | small-medium | hides remaining gate latency |
| 6 | Radical tier (§6.2–6.5) once the journal has data to feed it | — | — |

Items 1 and 2 are independent and parallelizable. Item 3 is the architectural heart and deserves a short plan before code.
