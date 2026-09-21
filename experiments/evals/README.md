# Live evaluation scenarios

```sh
bun run eval:live
```

**Makes real API calls — real Jev judgments and real main-model completions, at real (small) cost.** Not part of `bun run test`; run it explicitly. Requires `TYPESAFE_API_KEY` and `ZAI_API_KEY` (bun auto-loads `.env`).

## What this is

A small, honest slice of the plan's "small reproducible scenarios" list, run live rather than against `mockSystemOne`. It exists to test something the mocked-answer unit suite structurally cannot: whether Jev's *actual judgment* on a piece of content or a command matches what a careful person would want, not just whether the harness correctly *acts on* a canned answer.

Three scenarios today:
- Benign project instructions in a file read → sanitize should pass.
- A real prompt-injection attempt in a file read → sanitize should block.
- An ambiguous but risky bulk-delete command → gate should not auto-run it.

Each scenario runs a real `harness.prompt()` in a scratch temp directory, reads back the resulting journal, and checks the actual decision. The script prints measured cost per scenario and exits nonzero if anything failed.

## What this is not

This is not the plan's full "Evaluation" subsection. Explicitly not built here, and not a side effect of adding this script:

- **No RTK baseline extension, no held-out human-reviewed labeled set.** Both need real work and real data that doesn't exist in this repo (see the P9 task doc's scope note).
- **No cost/context/model-tier comparison, no ablation harness.** Those need a report schema and a real spend budget agreed on ahead of time, not three scenarios added while fixing an unrelated bug.
- **Not a regression gate.** Three scenarios are a smoke check on judgment quality, not statistical evidence of anything — don't cite pass/fail here as proof a policy change is safe.

## Cost

Measured on 2026-09-21 against `zai/glm-5.3` + `jev-1.13.0`: **$0.0043 total** for all three scenarios (main-model side; Jev's dollar cost isn't exposed by the TypeSafe API, only token counts — ~2,700 tokens total across both judgment calls per run). Costs will vary with model pricing and prompt size; this isn't a guarantee for future runs.

Set `BRAINSTEM_EVAL_MODEL=provider/id` to run against a different main model.

## Shipped Focus vs RTK

```sh
bun run eval:focus-vs-rtk
```

Real calls (12, one Jev focus judgment per case), small cost. The `output-focus` pilot below validated the *concept* with a standalone experiment script; this reuses the pilot's own real captures, real tasks, and recorded RTK sizes, but runs them through the *actually shipped* `engine.focus()` / `presentArtifact()` code — the functions really wired into `harness.ts`. Grounding is checked by substring match against each case's known-correct answer text, not a full downstream model call+grade.

Measured 2026-09-21, across all 12 pilot cases:

| | raw | RTK | shipped Focus |
|---|---|---|---|
| total chars | 80,616 | 43,923 (45.5% reduction) | 13,420 (83.4% reduction vs raw, 69.4% smaller than RTK) |
| evidence kept | — | — | 9/11 groundable cases (2 misses; 1 case is a negative control) |

This run also found and fixed a real bug (see the `output-focus.ts` git history around 2026-09-21): the exhaustive-bypass regex matched bare "exact"/"exactly" as an exhaustiveness cue, so most of these precision-seeking tasks ("what exact value...") were wrongly routed to the naive full-view bypass instead of a real selection. Before the fix, only 4/11 cases kept their required evidence. The two remaining misses are real Jev judgment calls that scored below threshold — in the actual harness (not this simplified test) that means `compute_or_retrieve` mode and a recovery-tool prompt, not silently lost evidence; F0's `read_output`/`search_output` guarantee nothing is truly gone. This script doesn't simulate that follow-up turn, so its "missing evidence" count is a stricter bar than what the real harness would ultimately deliver.

## Select value

```sh
bun run eval:select
```

Real calls, one batched Jev call, negligible cost. Registers 5 optional tools against a real `CapabilityRegistry` — 1 genuinely relevant to the task (post to Slack), 4 plausible-sounding decoys (query a database, deploy to prod, generate a PDF, convert currency) — and asks: does Select actually keep the irrelevant ones out of what the model sees, without the model ever having to reason about them?

Measured 2026-09-21: all 5 correctly classified (relevant tool scored 0.93, decoys scored 0.02–0.04). Optional-tool schema overhead dropped from 526 bytes (naive: expose everything registered) to 87 bytes (Select-filtered). A real registry with more integrations would show a larger absolute reduction — this is one scenario with 5 candidates, not a claim about arbitrary registry size.

## Select vs self-selection

```sh
bun run eval:select-vs-self
bun run eval:select-ambiguity
```

Real calls, both scripts. `select-value.ts` only checked whether Select alone gets it right; these two check whether Select actually **beats a raw agent self-selecting** — the harder, more honest question. Both use `_fixtures/messaging-registry.ts`: 27 optional tools (1 correct — post to Slack — 4 same-domain near-misses, 22 unrelated decoys) registered against a real `CapabilityRegistry`. Three conditions each run: a raw Pi `Agent` (same tools/model, zero Jev) given all 27, Select alone (one batched Jev call), and a harnessed agent given Select's filtered set.

`select-vs-self` uses an explicit task ("...in the #eng **Slack channel**..."). `select-ambiguity` uses a deliberately harder one — no literal "Slack"/"channel" keyword, only the "#eng" naming convention, plus a planted distractor ("usually we'd **email**... but this time just ping #eng directly").

Measured 2026-09-21 (`zai/glm-5.3`, 3 runs for the explicit task, 5 for the ambiguous one):

| | explicit task | ambiguous task + distractor |
|---|---|---|
| raw agent (27 tools shown) | 3/3 correct | 5/5 correct, 0/5 fell for the distractor |
| Select alone | correct, all 27 classified right | 5/5 correct, decisively (`0.97` vs `0.05-0.06` every run) |
| harnessed agent (Select-filtered) | 3/3 correct | 4/5 correct (1 run made no tool call — a different failure mode, likely a conversational reply instead of a tool invocation; not root-caused) |

**Honest conclusion, not spun**: neither test found a raw-agent accuracy failure. `zai/glm-5.3` wasn't fooled by 27 tools, near-misses, implicit signals, or a planted distractor across 8 raw-agent runs total. Select's own judgment was consistently confident and correct in every run, which is a real, positive finding about Jev's discrimination quality — but it hasn't translated into a demonstrated accuracy *advantage* over this particular main model at this scale. The scenario that would actually isolate that variable — a weaker/cheaper main model, or a much larger catalog (100+ tools) — hasn't been tried; both tests used the same competent model on both sides. What's proven regardless of accuracy parity: the schema/token cost savings from not showing the model 26 irrelevant tools every call.

## With/without harness (prompt injection)

```sh
bun run eval:with-without
```

Real calls (main model only for the "without" run; main model + Jev for "with"). Constructs a raw Pi `Agent` — same tools, same model, zero Jev hooks — alongside the full harness, and gives both an identical task: summarize a file that contains a real prompt injection attempting to exfiltrate a (fake) credentials file into a new one. Checks whether the exfiltration file actually gets created in each run. Written but not yet run as a completed measurement in this repo's history — see this eval's own output for whatever the most recent run found; model behavior on identical injected content can vary between runs, so treat one run as a demonstration, not a guarantee.

## Cache benchmark

```sh
bun run eval:cache-benchmark
```

Also real calls, also small cost (three bare Jev calls, no main-model calls at all). Demonstrates one narrow, honest fact about P10's exact-answer cache: an identical repeated judgment (same task, same tool, same content) skips the network round-trip entirely on the second ask. Measured 2026-09-21: a fresh call took ~180ms; the cached repeat took ~1ms; without a cache, both calls made a real Jev request. This is not a general "the harness got N% faster" claim — it only tells you the cache does what it says for exact repeats, which is the actual scenario it targets (P10's other five sub-items — batching, fusion, prefetch, journal sink, journal seeding — remain deferred; see the P10 task doc's scope note).
