# Jev output-focus pilot: results and implementation consequences

**Date:** 2026-09-20  
**Status:** Live pilot completed; exploratory results, not a production benchmark.  
**Runner:** [experiments/05-output-focus.ts](../../experiments/05-output-focus.ts)  
**Protocol and reproduction:** [experiment README](../../experiments/output-focus/README.md)  
**Recorded results:** [summary.json](../../experiments/output-focus/results/summary.json)

## Decision

Proceed with **opt-in, task-aware Jev extraction of new tool output**, with artifact retrieval and an explicit bypass for tasks requiring complete output. Do not ship unconditional focusing, continuously prune past history, or reproduce RTK's command-specific filter library.

The pilot supports the narrower hypothesis that Jev can preserve task-specific evidence while exposing substantially less text. It does **not** demonstrate better correctness than raw output, lower latency, or universally lower cost. With the inexpensive downstream model used here, paying for a fresh selection on each decision was slightly more expensive than raw input.

## What ran

Four synthetic fixture outputs were captured from real commands: verbose Vitest, TypeScript diagnostics, Git log, and ripgrep. Three tasks were paired with each output, giving 12 cases. The fixtures include passing-test timing, a skipped authorization test, exact assertion values, commit-body requirements, configuration overrides, an exhaustive compiler-file count, and a missing-evidence control.

The three arms received the same captured evidence:

1. **Raw:** complete captured output.
2. **RTK pipe:** official RTK 0.49.0, `rtk pipe --filter vitest|tsc|git-log|grep`, applied to that capture.
3. **Jev focus:** split output into contiguous line chunks targeting 650 characters; show Jev every chunk, the task, command, and exit code; ask one relevance Noul per chunk; select scores at least 0.55 within a 40% character budget (900-character minimum).

The selected original sections were rendered in source order with omission markers. A manifest hash and real base64-encoded bitmap record the selection. No tool-specific parsers or gold answers were given to Jev. Section labels add a small amount beyond the extraction budget.

Jev was pinned to `jev-1.13.0`. The downstream model was `zai/glm-5.3-flash`, low reasoning, temperature zero, 1,800-token response cap. Each arm ran twice per case: **72 initial downstream calls**. Jev selection ran once per case and was reused for the two repetitions: **12 selection calls**. Reduced views could request the complete original artifact once: **13 recovery calls** occurred. No model-generated shell commands were executed.

All API requests used synthetic fixture content. The downloaded RTK archive was checksum-verified; its version and digest are recorded in [protocol.json](../../experiments/output-focus/results/protocol.json). No runtime harness behavior was changed for this pilot.

## Results

| Metric | Raw | RTK stdin filters | Jev-focused |
|---|---:|---:|---:|
| First decisions meeting the exact-answer/abstention contract | 23/24 | 10/24 | 22/24 |
| Correct with valid verbatim evidence quotes | 23/24 | 10/24 | 21/24 |
| Correct after at most one artifact recovery | 23/24 | 21/24 | 22/24 |
| Extra evidence requests on answerable tasks | 1 | 11 | 2 |
| Artifact recovery calls actually made | 0 | 11 | 2 |
| Presented output characters, summed over repetitions | 159,780 | 87,846 | 24,164 |
| Initial downstream input tokens, including cache tokens | 48,454 | 26,710 | 11,174 |
| Mean initial downstream request latency | 1,601 ms | 2,286 ms | 1,932 ms |
| Mean observed decision path including filtering and recovery | 1,601 ms | 3,023 ms | 2,373 ms |
| API/transport errors | 0 | 0 | 0 |

Jev exposed **84.9% fewer output characters** and **76.9% fewer initial downstream input tokens** than raw. It retained task-specific evidence for all positive local-lookup cases. Its average selection latency was **266 ms**, median **216 ms**, maximum **459 ms** over 12 requests. The latency samples are small and include service variation; concurrent requests do not establish an end-to-end harness speedup.

The raw arm's one strict miss actually contained the correct production issuer but unnecessarily set `needMore: true`. It is a failed first-decision contract, not a lost literal. Jev's additional strict evidence miss was a correct authorization answer accompanied by one inaccurate quotation (`legacy-orch-29` rather than `legacy-orchid-29`). Keep answer correctness and quotation fidelity separate.

RTK's malformed-JSON response on one slow-test repetition described the need to retrieve but did not satisfy the structured response contract, so automatic recovery did not run for that repetition. It is a downstream formatting failure, not another filter-specific loss.

## The failure that changes the design

Both Jev misses were the exhaustive question: “How many distinct source files have compiler diagnostics?” The original capture contains diagnostics for 26 authored files. Selection retained only a subset. The downstream model correctly refused to infer the full count and requested the original artifact, but then miscounted it in both recoveries.

This produces two separate requirements:

- **Scope/completeness:** when the task depends on all records, selecting locally relevant sections cannot preserve the necessary evidence. Choose a full/paginated view or a deterministic computation over the artifact.
- **Arithmetic:** a full view still does not guarantee a generative model counts correctly. Use code for exact counts; Jev may identify that the task needs complete evidence, but it should not perform the count.

RTK's `tsc` view was identical to raw in this experiment, yet its two downstream count answers were also wrong while both raw-arm answers were right. That variability is another reason not to interpret this small study as an accuracy ranking across products.

On the missing-timeout case, Jev selected zero sections and the downstream model requested more evidence, as intended. One answer described the capture as having no matching lines even though only the **selection** was empty. Production result envelopes must distinguish empty source, no selected sections, unassessed sections, and withheld content.

## Cost accounting

Costs below are **SDK/catalog estimates**, not account billing reconciliation. Main-model usage is reported by the provider and priced by Pi's configured model catalog. Jev is estimated at $0.042 per million input tokens. Cache hits occurred in this pilot and are included in these estimates.

| Estimated cost over the recorded 24 downstream decisions per arm | Raw | RTK stdin filters | Jev-focused |
|---|---:|---:|---:|
| Initial downstream calls | $0.005638 | $0.003496 | $0.002049 |
| Recovery calls | $0.000000 | $0.002738 | $0.000266 |
| Actual selection calls, reused across repetitions | — | — | $0.001964 |
| Total observed pilot estimate | $0.005638 | $0.006234 | $0.004278 |

Because each Jev view was reused for two repetitions, the observed total benefits from reuse. Charging a fresh selection for each of the 24 decisions gives **$0.006242**, approximately **10.7% more than raw**. That is an illustrative accounting scenario using the observed mean selection cost, not another live run. If model behavior were unchanged with cache misses, downstream costs could also differ; the scenario is not a billing forecast.

The actual pilot's combined estimate across all three arms is about **$0.01615**. Larger downstream models or reuse of a reduced result across many subsequent turns could change the economics, but this experiment did not test those conditions. Conversely, raw history may be cheaply cached. Production policy must compare selection cost, cache creation/read behavior, retrieval costs, and measured task outcomes.

## Why the RTK comparison has a limited claim

This tested **RTK stdin filters on fixed text**, not RTK's native command wrappers. Native wrappers can change command flags or request structured reports; they can produce better views than their stdin fallback. Here:

- Vitest's text filter kept failure names but omitted assertion values, passing-test timing, and the skipped test.
- Git-log's stdin filter retained the latest entry and an omission marker, excluding the targeted older commits.
- The supplied TypeScript and grep captures passed through unchanged.

The compression levels were not matched. This demonstrates a useful task-aware alternative to these specific filters, not superiority over RTK as a whole. A follow-up must include native RTK execution and a generic head/tail control at matched budgets, with command-semantic differences recorded.

## Implementation consequences

1. Add **Focus** as a separate optional reflex before a new tool result enters model history.
2. Preserve the original output as a bounded, versioned artifact with explicit capture limits and expiry. Support ranged retrieval and search; recovery must not rerun side effects.
3. Use generic structural sections, exact source spans, and versioned bitmaps. Do not build a command-specific RTK clone.
4. Add an explicit completeness decision before pruning: `full`, `select`, or `compute/retrieve`. User requests for exact/full output and obvious exhaustive operations override optional selection.
5. Preserve command identity, exit status, source size, selection coverage, and artifact identity in every view. A selected subset must never look like the complete result.
6. Keep selection before sanitize, checking the exact final presented content. Artifact reads use the same boundary. Provider-only opaque reasoning blocks are never section candidates.
7. Do not rewrite committed views every turn. Introduce compaction checkpoints only at measured context pressure, following each provider's history/opaque-block rules.
8. Treat tool/skill-set changes as potential cache-prefix changes. Keep capability sets stable within an execution phase, and use provider-native deferred loading only when supported and tested.
9. Roll out Focus in shadow/opt-in mode first. Benchmark multiple real tasks, downstream models, and output sizes, including full-context counting and negative controls. No automatic “compression saves money” claim.

These changes are incorporated into [the consolidated implementation plan](../plans/2026-09-20-harness-evolution.md).

## Verification and limits

`--verify` checks capture hashes, complete contiguous section coverage, exact source extraction, bitmap dimensions/membership/padding, view reconstruction, and all 72 decision identities. Typechecking and the existing repository test suite remain separate checks; none of the intentionally failing synthetic fixture tests are included in that suite.

The 12 tasks were authored, not randomly sampled. The same Jev decisions were reused across two repetitions, and temperature zero did not make downstream results deterministic. Shared prefixes and identical raw/RTK views in two categories can warm caches across arms; rotated order reduces but does not remove that interaction. The evaluation measures one next decision plus optional retrieval, not a patch or completed agent task. Selection questions, thresholds, and budgets were not retuned after inspecting the downstream answers. No production recommendation should be based on the compression percentage alone.

## Sources

- [RTK v0.49.0 release](https://github.com/rtk-ai/rtk/releases/tag/v0.49.0)
- [RTK Vitest implementation](https://github.com/rtk-ai/rtk/blob/v0.49.0/src/cmds/js/vitest_cmd.rs)
- [RTK recovery implementation](https://github.com/rtk-ai/rtk/blob/v0.49.0/src/core/retriever.rs)
- [Daily.dev compaction critique](https://daily.dev/posts/jev-s-compaction-strategy-is-getting-roasted-and-the-critique-is-pretty-damning-fqoujnfcb) — discussion summary; the pilot does not adopt its unverified performance claims.
- [fast-jev-compaction design](https://github.com/tamaratran/fast-jev-compaction#how-it-works) — omits actual result bodies from selector state; Brainstem's pilot supplied actual section content.
- [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Anthropic tool caching and deferred loading](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
