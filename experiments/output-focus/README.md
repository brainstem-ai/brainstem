# Output-focus pilot

This is a controlled, synthetic evidence-selection experiment, not a full coding-agent benchmark. It compares raw captured output, **RTK 0.49.0 stdin filters**, and generic Jev-guided section extraction. It does not reimplement RTK filters.

## Reproduce

Prerequisites: the repository dependencies, Bun, Git, ripgrep, the RTK binary, and configured `TYPESAFE_API_KEY` / `ZAI_API_KEY` for live inference.

```sh
# RTK is not installed globally. Set this to the pinned binary you downloaded.
export BRAINSTEM_RTK=/tmp/brainstem-rtk-v0.49.0/rtk
bun experiments/05-output-focus.ts --prepare
bun experiments/05-output-focus.ts --live
bun experiments/05-output-focus.ts --report
bun experiments/05-output-focus.ts --verify
```

`--prepare` creates isolated synthetic fixtures under `/tmp/brainstem-output-focus-fixtures`, captures real command output, and applies RTK through `rtk pipe --filter`. Expected test/compiler failures are fixture data. The fixture tests are outside the repository's normal test suite. No user project output or credential values are sent to either API.

Run preparation only for a **fresh** experiment. It changes duration-bearing captures; the runner refuses to overwrite captures after saved inference exists. For an exact replay of the recorded experiment, use `results/captures.json` and `results/cases.json` and do not rerun preparation. To run a new experiment, set `BRAINSTEM_FOCUS_RESULTS` to a fresh directory before preparation and inference. The live command resumes already saved judgments and answers; it does not silently pay for them again.

The download used in the recorded pilot is the official `v0.49.0` macOS ARM64 archive, SHA-256 `bbbfebabb22686993a80da731aa4d5d35116fb8ae24abb00608efa028e13ae01`. Other platforms should use the matching official release asset and record its digest.

## Fixed protocol

- Four outputs: verbose Vitest, TypeScript diagnostics, Git log, and ripgrep results.
- Twelve task/output pairs, with three different tasks per output. Includes passing-test performance, skipped-test coverage, commit-body instructions, a whole-output count, and a missing-evidence control.
- Each pair is evaluated twice in each of three arms: 72 initial calls to `zai/glm-5.3-flash`, temperature 0, low reasoning, 1,800-token response cap.
- Rotate arm order by case/repetition. Calls run with concurrency three. Requests are independent; no conversation history is shared across arms.
- One Jev selection per task is reused across the two downstream repetitions. This measures a fixed selection, not selector variance.
- Generic contiguous chunks target 650 characters without splitting lines. Jev sees all chunks, the task, command, and exit code. No command-specific extraction or gold labels are supplied.
- Select chunks scoring at least 0.55, greedily by relevance, within 40% of original characters or a 900-character minimum. Presentation labels add overhead beyond that extraction budget.
- The selected membership is stored as a real bitmap, with a section-manifest hash, exact offsets, scores, and selected IDs for inspection.
- Main-model output is constrained to JSON with an answer, exact evidence quotes, and a request-more-evidence boolean. It does not see the arm name or gold answers.
- A requested retrieval from a reduced view receives the original captured output, with at most one additional model call. A request about evidence absent from the complete capture is scored as correct abstention and does not trigger a pointless recovery call.
- Gold labels and thresholds are fixed before main-model evaluation. The count label is 26 authored compiler-error source files; other positive labels require arbitrary literal values/names present in the capture.

## Interpretation limits

RTK's `pipe` filters are an exactly reproducible same-input baseline. They are **not equivalent to every native RTK command wrapper**, some of which change upstream command flags or request structured output. In this pilot, the `tsc` and `grep` stdin filters pass these particular captures through unchanged. Do not generalize results to all RTK integrations or claim the arms have equal compression budgets.

The fixtures are authored to exercise different evidence needs, not sampled production traffic. Two repetitions at temperature zero are not independent task samples. Literal-match correctness and verbatim quotation checks are useful narrow metrics; they do not establish patch quality or task completion. Review recorded answers as well as aggregate scores.

Main-model costs are SDK catalog estimates from reported usage, not billing reconciliation. Jev cost uses the documented input-token rate recorded in the experiment. Focus views are reused across repeats: report both actual pilot spend and a scenario charging selection on every fresh task. Model latency includes service variability and concurrency; total application latency and prompt-cache behavior need a separate multi-turn benchmark.

## Artifacts

`results/protocol.json`, `cases.json`, and `captures.json` fix the inputs and labels. Plain-text raw/RTK captures are also included. Each `*.focus.json` contains Jev's scores, bitmap, and extracted view. Each `*.<arm>.<repeat>.json` contains the downstream answer, grading, reported usage, latency, and optional recovery. `summary.json` is generated from those records.

Live calls are bounded to 12 Jev calls, 72 initial main-model calls, and at most 48 recovery calls; provider errors are recorded rather than retried automatically. Actual recovery demand is generally lower. This experiment deliberately performs no model-generated shell execution.
