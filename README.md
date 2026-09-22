# brainstem

A coding-agent harness where Jev (TypeSafe's System One model) makes bounded judgments — gate, sanitize, verify, pulse, steer — and the LLM only generates.

## Who owns what

| Owner | Responsibilities |
|---|---|
| Harness code | Execution, permissions, budgets, context assembly |
| Jev (System One) | Narrow semantic judgments over supplied evidence (gate/sanitize/verify/pulse/steer) |
| Main model | Strategy, code, explanations |
| User | Intent, constraints, approvals |

## Reflexes

Implemented: **Gate**, **Sanitize**, **Verify**, **Pulse**, **Steer**, **Select**, **Focus**

**Tend** is a later checkpoint workflow, not a continuous filter.

What each reflex is shown is as much a part of the contract as what it decides:

| Reflex | Evidence it receives |
|---|---|
| Gate | The real action — the command, or for a write a bounded diff (existing file) or first-40-lines summary (new file), flagged when the evidence is incomplete. The approval hash stays out of it. |
| Sanitize / Verify | One bounded envelope: task, source, action summary, capped intent, status, truncation, and the exact content actually delivered — never a second independent slice of the raw capture. Reviewed regardless of `isError`: a thrown tool error's text gets the same review as any other output, not a bypass. The bound is one shared character cap (`packages/core/src/presentation.ts`, `REVIEW_CHAR_CAP` = 8,000 chars) applied once, before both Sanitize and delivery — a single very long line cannot exceed it either. |
| Pulse | Recent actions with statuses, labelled repeat counts, failure fingerprints, and whether the approach changed — all computed in code. |
| Steer | The latest completed observation and the active capability descriptions. |
| Select | One independent relevance judgment per optional catalog capability, batched by size; code always includes baseline and explicit selections. |
| Focus | One independent relevance judgment per structural output section (paragraphs, header/child groups, or line windows), with a dependency closure and a byte budget. Off by default — see below. |

Literal facts are never delegated: containment, counts, durations, exit codes and
budgets are computed in code. A write resolving outside the project root skips
Gate's judgment entirely and takes the static floor verdict.

## Setup

```sh
bun install
```

`.env` needs `TYPESAFE_API_KEY` and `ZAI_API_KEY` (bun auto-loads it). Example:

```sh
bun packages/cli/src/main.ts --cwd /tmp/repo --task "fix the failing test" --trust 0.5
```

## Trust dial

`trust` raises/lowers the auto-run CONFIDENCE BAR (`policy.ts`: `autoConfidence = 0.95 - 0.35*trust`). `trust 0` does NOT mean "ask about everything". Safety thresholds (deny lines, credential nouls) never change with trust.

## Approvals

A gate `ask` opens a pending approval and waits inside the pre-execution hook.
Approval permits that exact validated action once; denial, EOF, and cancellation
execute nothing, and neither elapsed time nor an empty response approves. If the
action changes between request and resolution, the approval is invalidated.

The approval's identity (its `actionHash`) covers tool, canonical resolved
target/cwd, all validated non-content arguments, and — for a write — a digest
and byte length of the proposed content plus a digest of the file's existing
content at request time. Approving a write with one payload never permits a
different payload, and a file edited (or its target substituted) between
request and resolution invalidates the approval instead of silently executing
against whatever now sits at that path. The interactive approval prompt is
shown the actual proposed diff/new-file summary, not just the command or path;
the durable journal entry stays bounded (hash + reasons only).

Without an approval handler (a non-interactive run), an `ask` returns a blocked
tool result telling the agent to ask the user, and the CLI exits nonzero.

## Write safety

Every write (both the harness's pre-execution gate and the `write` tool's own
execution) resolves the target through one shared canonical resolver
(`packages/core/src/paths.ts`, reused by `packages/core/src/floor.ts`'s static
policy and `packages/cli/src/paths.ts`'s execution helpers), and rejects a
write whose final path component is a symlink — existing (inside or outside
the root) or dangling — with an explicit blocked outcome, before Jev ever sees
it. The write itself lands via a same-directory temp file + atomic rename,
which never dereferences a destination symlink and never truncates a
hard-linked file's shared inode in place.

**Supported guarantee:** final-symlink rejection and hardlink-safe atomic
replacement are structural (kernel-enforced by `O_*`/`rename()` semantics),
not probabilistic. **Not claimed:** full descriptor-relative (`openat`-style)
traversal — Bun/Node expose no public API for it — so a symlink substituted
into an *intermediate* ancestor directory between path resolution and the
final rename is a real, unclosed TOCTOU window on this platform. Closing it
fully requires a native addon or an external sandboxing executor; this
release does not claim that guarantee, per the review remediation plan's
explicit escape hatch (see `docs/plans/2026-09-22-review-remediation.md`, R2).

## Managed process termination

The `bash` tool launches commands in their own POSIX process group (via
`detached: true`) and, on timeout or cancellation, signals the whole group —
not just the immediate shell — with SIGTERM, a short configurable grace
period, then SIGKILL. Pipe drainage is bounded past that point so a lingering
descendant cannot hang the tool call indefinitely.

**Supported guarantee:** ordinary parent/child/grandchild descendants,
including a process that ignores SIGTERM, are terminated within the
configured deadline plus grace/cleanup allowance. **Not claimed:** containment
of a deliberately detached daemon (e.g. a double-forked process that leaves
the group via `setsid`) — that requires an outer sandbox/supervisor boundary,
which this harness does not provide. Windows has no process-group kill
primitive here and falls back to signalling only the direct child; this is a
documented platform limitation, not process-tree cancellation.

## Output artifacts and recovery

Every captured tool result — success or a thrown tool error, including empty
output — is stored whole, as separate named streams (`stdout`/`stderr` for
`bash`, a single `output` stream for everything else), before any reduced
view is presented, so nothing the model was not shown is lost. The bash
tool's own capture limit is a per-stream byte cap (256,000 bytes), decoupled
from the much smaller character budget used for what's actually displayed —
a 60,000-character capture is never marked complete after silently losing
characters to a display-oriented cap, and a `read` beyond its size limit is
read with bounded streaming, never loaded whole into memory first. Whitespace
is preserved; `(no output)` is presentation wording substituted at delivery
time, never baked into the archived capture.

Artifacts are stored per session, under
`<journal-parent>/sessions/<sessionId>/artifacts` (the session id comes from
`SessionRecorder`, never a timestamp-only directory name). Every artifact is
stamped with its owning session and validated on every read; a malformed or
foreign id is rejected before any filesystem path is ever derived from it.
Two sessions sharing a journal parent directory can never read or evict each
other's artifacts. Tombstones (evicted-but-remembered metadata) are bounded
by a retention horizon; beyond it a purged id reports "unknown" rather than
"expired" — the store genuinely no longer has evidence to distinguish the
two. Pre-existing artifacts from the old shared-directory layout are neither
migrated nor deleted by this change; a new session simply never reads them.

Two always-available tools recover a capture without rerunning the command:

```
read_output({ id, stream?, startLine, lineCount, startByteInLine? })
search_output({ id, stream?, pattern, limit, startLine? })
```

Responses carry their real source ranges (or, for a single line too large for
one page, an explicit UTF-8 byte range and a `startByteInLine` continuation
value) and completeness markers, and pass through the same bounded
presentation and sanitize path as any other tool result — including hostile
content in a late recovery page. Unknown ID, unknown stream, evicted artifact,
capture truncation, and empty source are distinct outcomes — never a bare "no
output". `search_output`'s `startLine` resumes a prior truncated scan from
where it left off (via the `scannedTo` receipt) without re-scanning or gaps.

## Focus rollout

`--focus-mode off|shadow|on` (default `off`) controls whether Focus's section
selection ever shapes what the model sees:

- `off` — the artifact's bounded view is the first 10 lines plus a recovery
  notice, same as always. No Focus judgment runs.
- `shadow` — Focus runs and its decision is journaled (mode, status, section
  manifest hash), but the presented view is unchanged from `off`. Use this to
  evaluate selection quality and cost before trusting it to shape output.
- `on` — a `"select"` decision presents only the relevant sections plus a
  coverage receipt (`showing K of N sections... use read_output or
  search_output to recover the rest`); a `"full"` or `"compute_or_retrieve"`
  decision falls back to the bounded view. Internal scores never appear in
  presented text. Sanitize always judges the exact bounded view the model
  will see, never a separate slice of the raw capture.

## Replay

```sh
bun packages/cli/src/main.ts replay <journal.ndjson> [--trust N] [--mode policy|reevaluate]
```

Re-scores recorded judgments offline against a different policy, resolved strictly by `judgmentId` — never by "the most recently seen judgment of this type," which could silently misattribute an unrelated earlier judgment's answers to a decision that was never actually sent to Jev. The report distinguishes three outcomes: `replayed` (a resolved judgment, re-decided — this is what `unchanged`/`changed` count), `static-only` (no judgment at all — a floor verdict, never replayable), and `unsupported` (a `select`/`focus` decision, whose bitmap outcome can't be reconstructed without the full catalog or section manifest recorded alongside it — not yet journaled; visible in the report rather than silently dropped).

`--mode reevaluate` (new live judgment calls, not offline reuse of recorded scores) is recognized but not implemented — it exits with an explicit error rather than silently no-op'ing. `--mode policy` (default) never makes an API call. Side effects and human approvals are never replayed; approval remains a recorded historical outcome that a changed policy cannot manufacture.

## Answer cache

Every reflex — gate, sanitize, verify, pulse, steer, select, focus — shares one bounded, in-memory exact-answer cache by default (no configuration needed; pass `answerCache` to `createHarness` to override or disable). A judgment is cached only on success and is checked *before* any budget gate, since reuse costs zero new provider calls; on a hit, the cached answers are re-validated against the current question table before use, and a stale/incompatible entry silently falls through to a fresh call rather than surfacing as a new failure. Concurrent identical requests are deduplicated into one in-flight call. Journal `reflex` events record `cacheHit`/`cachedFromJudgmentId` so a cache hit's provenance stays distinguishable from a fresh one. See `docs/tasks/p10.md` for what's covered and what's deliberately deferred (gate batching, pulse/steer/select fusion, a buffered journal sink, gate prefetch, journal seeding).

## Versions

The `@earendil-works/pi-*` dependencies (0.86.1) are pinned deliberately; upgrades are explicit checks.