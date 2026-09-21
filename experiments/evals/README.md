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

## Cache benchmark

```sh
bun run eval:cache-benchmark
```

Also real calls, also small cost (three bare Jev calls, no main-model calls at all). Demonstrates one narrow, honest fact about P10's exact-answer cache: an identical repeated judgment (same task, same tool, same content) skips the network round-trip entirely on the second ask. Measured 2026-09-21: a fresh call took ~180ms; the cached repeat took ~1ms; without a cache, both calls made a real Jev request. This is not a general "the harness got N% faster" claim — it only tells you the cache does what it says for exact repeats, which is the actual scenario it targets (P10's other five sub-items — batching, fusion, prefetch, journal sink, journal seeding — remain deferred; see the P10 task doc's scope note).
