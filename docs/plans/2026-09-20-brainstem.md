# Brainstem — Dual-Brain Agent Harness Implementation Plan

**Goal:** A minimal coding-agent harness where Jev (TypeSafe's System One model) owns every non-generative decision in the loop — gate, sanitize, steer, tend, pulse, verify — and the LLM is a pure generator.

**Architecture:** A standalone **reflex engine library** (`packages/core`: question tables + policy + journal, zero harness deps) consumed by a thin CLI built on `@earendil-works/pi-agent-core`, whose hooks (`beforeToolCall`, `afterToolCall`, `transformContext`, `shouldStopAfterTurn`, `subscribe`) are exactly the reflex insertion points. The same core can later power a proxy shell for existing harnesses ("Supervisor") and a workflow-runtime shell ("Inverted Harness").

**Tech stack:** TypeScript + Bun, `@typesafe-ai/sdk` (v0.6.0), `@earendil-works/pi-agent-core` + `pi-ai`, vitest, NDJSON journal.

## Codebase Context

**Prior art studied:**

- TypeSafe docs (docs.typesafe.ai): primitives (Choice/Score/Noul), confidence semantics (derived from probability-distribution shape; 3-band routing pattern), speculative fan-out, confidence-gated routing, Jev 1.13 jaggedness (literal reading, no math/counting/dates, context rot, adversarial content can steer it), models page (64k context, 32k state+longest-question, 250k tok/s, 1200 rpm, $0.042/MTok, version pinning via `response.model`).
- Cookbooks: llm_guardrails (Noul battery + severity Score + thresholded `route()` — the Sanitize blueprint), skill_suggestion (two-call rank/rerank for high-cardinality choices; 182 options in one Choice), function_calling, parallel_questions.
- Pi agent-core (earendil-works/pi): hook surface, event stream, steering/follow-up queues, injectable `streamFn`, session backends, MIT.
- Landscape: DeepSeek dsh (everything-is-a-plugin), Harness File corpus (prompts 2KB–50KB), SoL-Pi (~20 benchmark points from harness tuning).
- Fallbacks: `system-one-adapter-python` (LLM-backed drop-in TypeSafeClient, MIT), Vercel AI Gateway route `typesafe-ai/jev`.

**Design rules (each maps to a documented Jev weakness):**

1. Static permission floor; Jev can only escalate risk, never de-escalate below it (adversarial content can steer Jev).
2. Code owns math, budgets, counting, irreversible-flag detection (Jev can't).
3. Reflex state is curated — task, last N events, pending action — never the raw transcript (context rot; 32k state cap).
4. All thresholds and weights live in one `policy.ts`; pin `jev-1.13.0` and log `response.model` (threshold tuning is the real work).
5. `decide()` is a pure function of (answers, policy) — fully unit-testable and journal-replayable.

## Repo layout

```
brainstem/
  packages/core/          # reflex engine — no Pi, no CLI deps
    src/system-one.ts     #   port: ask(state, questions) -> Answers
    src/providers/        #   jev.ts | gateway.ts | llm-adapter.ts | mock.ts
    src/questions/        #   gate.ts sanitize.ts steer.ts tend.ts pulse.ts verify.ts
    src/policy.ts         #   all thresholds, weights, trust-dial mapping
    src/engine.ts         #   fires batched calls, combines answers -> decisions
    src/journal.ts        #   append-only NDJSON event log
  packages/cli/           # harness: pi-agent-core + core wired via hooks
  experiments/            # Phase 0 spikes (committed)
  docs/plans/
```

Core abstraction:

```ts
interface Reflex {
  id: "gate" | "sanitize" | "steer" | "tend" | "pulse" | "verify";
  buildState(ctx: LoopContext): JsonValue;
  questions(ctx: LoopContext): Questions;          // speculative fan-out
  decide(answers: Answers, policy: Policy): Decision;  // pure
}
```

## Architecture Decision

**Chosen:** core engine is Pi-free (portable library); CLI composes `pi-agent-core` instead of a from-scratch loop.

**Alternatives:** (1) from-scratch loop — rejected for Phase 1: Pi's hooks are an exact fit and we get multi-provider LLM, streaming, sessions, steering for free; (2) fork Pi — rejected: composition over fork keeps upgrades possible and core insulated.

**Trade-offs accepted:** pin exact pi versions (fast-moving API); reflex engine must not leak Pi types across the boundary.

---

## Phase 0 — Spike (current)

Access: user has a TypeSafe API key (bun auto-loads `brainstem/.env`).

### Task 0.1: Access check — `experiments/01-access.ts`

Run: `bun run exp:access` — expect model list + a noul answer ~1.0 for "mentions an animal".

### Task 0.2: Gate corpus (go/no-go) — `experiments/02-gate-corpus.ts`

58 labeled bash commands (21 auto / 20 ask / 18 deny incl. credential reads, exfil, system destruction, off-task). One call per command with 6 questions (destructive Score, credentials/exfil/outside/on-task Nouls, disposition Choice). Also computes static-regex floor + layered result.

**Exit:** ≥90% agreement on auto+deny bands; hard failures (2-band miss) < 5%; confidence mean on correct answers clearly above wrong ones.

### Task 0.3: Reflex batch timing — `experiments/03-batch-timing.ts`

21 mixed questions (gate/pulse/steer/tend over 10 chunks) over synthetic loop state, 10 runs.

**Exit:** p95 < 800ms; cost < $0.001/step.

### Task 0.4: Sanitize battery — `experiments/04-sanitize.ts`

20-item corpus (10 benign tool outputs incl. exploit docs and curl-pipe-sh *as documentation*, 10 attacks incl. DAN, injected README setup step, credential lure) with 3-Noul + severity battery, thresholds 0.35/0.7/2.0.

**Exit:** ≥90% attacks flagged; ≥80% benign pass; zero benign hard-blocks ideally.

## Phase 0 Results (2026-09-20) — **GO**

All four experiments pass against live `jev-1.13.0`:

| Experiment | Result | Exit criterion |
|---|---|---|
| 0.1 Access | 206ms, sane answer, model pin confirmed | works |
| 0.2 Gate corpus | AUTO 90.5% raw, DENY 100% raw, **0 hard failures** (58 cmds); confidence-routed overall 79.3%; static floor + routed 81% | ≥90% extremes, <5% hard failures — PASS |
| 0.3 Reflex batch | 23 questions/1 call: p50 195ms, p95 419ms, $0.00008/step, 1.9k tokens | p95 <800ms, <$0.001/step — PASS |
| 0.4 Sanitize | 10/10 attacks flagged, 9/10 benign passed, 0 false-blocks; noul separation dir 0.47–0.98 (attacks) vs 0.02–0.27 (benign) | ≥90% attacks, ≥80% benign — PASS |

Key findings for Phase 1 question design:

1. **Confidence is the reliable uncertainty signal**: mean 0.85 when correct vs 0.53 when wrong on the gate; both auto-band misses came in at conf ≤0.15 and route to `ask` under the confidence floor (conf<0.5 → ask), which is the safe behavior.
2. **Credential/exfil separation is excellent**: touches_credentials 0.94 on credential denies vs 0.14 elsewhere.
3. **Jev conditions disposition on task relevance** — it denied dangerous-but-off-task commands (`docker system prune` given "fix the auth test"). Safe direction, but Phase 1 must decompose: keep `destructive`/`on_task` as separate questions and let policy combine them (composite scoring), rather than bundling both into `disposition`.
4. **Jev is conservative on the ambiguous middle**: most `ask`-band misses were over-denies, never under-denies. Acceptable failure mode; the trust dial tunes it.
5. The benign `curl|sh`-as-documentation case correctly routed to `review` (danger 0.67), not block — severity and directive questions separate "describing" from "instructing".

## Phase 1 — MVP harness (week 1)

TDD per task (vitest + mock provider; live Jev only in marked integration tests). Full bite-size expansion at kickoff; task list:

1. ✅ Monorepo scaffold: `packages/core` + `packages/cli`, tsconfig, vitest.
2. ✅ `SystemOne` port + `jev` provider + `mock` provider (3 tests).
3. ✅ `journal.ts`: NDJSON append; `loadJournal` replay (3 tests).
4. ✅ `policy.ts` + trust dial: safety thresholds trust-invariant (5 tests).
5. ✅ `static floor`: deny/ask patterns from Phase 0 (6 tests).
6. ✅ `questions.ts`: gate + sanitize batteries as data (3 tests).
7. ✅ `engine.ts`: `decideGate`/`decideSanitize` pure + ReflexEngine with floor precedence (17 tests; sanitize restricted to hazard IDs after answer-pollution bug found in integration).
8. ✅ CLI harness: pi-agent-core Agent, `beforeToolCall`→gate (bash/write, static reads), `afterToolCall`→sanitize, events→journal, tools (bash/read/write/grep/glob), trust dial, one-shot + REPL. Integration tests run a fully scripted agent (mock streamFn): destructive bash blocked by floor with zero Jev calls, injected README blocked and replaced, safe command auto-runs (7 test files, 41 tests).
9. ⬜ Live smoke: `bun packages/cli/src/main.ts --task "..."` in a scratch repo (needs ANTHROPIC_API_KEY).

## Phase 2 — Full reflexes (week 2) — ✅ DONE

- ✅ **Pulse** (`shouldStopAfterTurn`, every N turns): repeating / progressing / stuck / worth-continuing battery → `continue` | `intervene` (steers the agent to change approach) | `stop` (ends the loop).
- ✅ **Steer** (streamFn wrapper): per-LLM-call model-tier routing between `--model` and `--mini-model` (zai: glm-5.3 vs glm-5.3-flash). Live demo: routed all turns to flash at conf 0.97–1.00 on a mechanical task.
- ✅ **Verify** (fused with sanitize via speculative fan-out — one call, 6 questions): does the tool output satisfy the tool-call intent; mismatch annotates the result for the LLM.
- ✅ **`brainstem replay <journal> [--trust N]`**: offline re-scoring of recorded journals against a new policy. Live: 9 decisions re-scored, policy flip detected (write auto→ask at low trust).
- Fix found by integration tests: pi-ai system messages carry string content (not blocks) — summarizer hardened; steered messages must use content blocks.

Deferred: ink TUI (stdout rendering suffices for now).

## Phase 3 — Publish

Tend (semantic compaction via `transformContext`), subagent Merge, README + demo gif + writeup. MIT.

## Risks

- Jev early access / rate limits (dynamic): gateway route + adapter fallback; cache all Phase 0 calls into fixtures.
- Confidently wrong gates: static floor, escalate-only, journal audits.
- Question tuning is the real work: replay tooling is the mitigation (Phase 2, pull forward if needed).
- pi API churn: exact-version pins; core has zero Pi deps.
