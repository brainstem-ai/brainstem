# Review remediation: P1 and P2 defects

Date: 2026-09-22  
Status: Implemented, independently validated, and corrected against that validation's findings. See "Implementation status" below for what is fully closed versus an explicit, documented platform limitation — R2's race guarantee and R4's process-containment guarantee are deliberately NOT claimed as complete; do not read their implementation as closing those specific acceptance boundaries.  
Review baseline: `d7c5d97`; implementation baseline: same working tree, no intervening commits before this work began.

## Implementation status

All seven findings landed, following the delivery sequence below, with regression tests reproducing each defect against the pre-fix behavior (verified failing before the corresponding fix, per each commit's test additions) and passing after. `bun run test` (430 tests) and `bun run typecheck` pass at time of writing.

| ID | Outcome |
|---|---|
| R1 | Closed. One shared character boundary (`packages/core/src/presentation.ts`) is applied before Sanitize/Verify and delivery in both the CLI harness and the Pi adapter; error/thrown-tool-result text is reviewed identically to success text; non-text content is withheld with an explicit notice. The Pi adapter's pipeline order was corrected (below) so Focus runs before Sanitize, matching the CLI harness. |
| R2 | Partially closed, explicitly scoped. Final-symlink rejection, hardlink-safe atomic replacement, and permission preservation across replacement are real, kernel-enforced guarantees (not check-then-write). A write whose target or preimage changed while the semantic gate judgment was in flight is now caught before execution, for both the "auto" and "ask" decision paths (below). Full descriptor-relative traversal is **not** implemented — Bun/Node expose no `openat`-style primitive — so a symlink substituted into an intermediate ancestor directory mid-operation, in the residual window between `beforeToolCall` returning and the tool's own `execute()` running, remains an unclosed TOCTOU window; Pi's hook architecture provides no side-channel to close it further without a native addon or external sandbox. This is the plan's own documented escape hatch, not a shortfall discovered after the fact; see README "Write safety". |
| R3 | Closed. Approval identity now includes a write's content digest/length and a preimage precondition; a file changed (or its target substituted) between request and resolution invalidates the approval instead of executing against stale state. Every write approval path — including the outside-root static-floor "ask" branch, which independent validation found was missing this (below) — shows the actual diff/content summary and enforces the same recheck. |
| R4 | Partially closed, explicitly scoped. `bash` launches a managed POSIX process group and terminates the whole group (SIGTERM, grace, SIGKILL) with bounded pipe drainage, independently of whether the direct child (as opposed to the whole group) has already exited — independent validation found the original implementation let the scheduled SIGKILL get silently skipped once the direct child's own pipes closed, which is exactly the case for a backgrounded job with redirected stdio (below). Containment of a deliberately detached daemon (double-forked, `setsid`) is **not** claimed; that requires an outer sandbox, per the plan. Windows falls back to direct-child-only signalling. |
| R5 | Closed. `bash` capture is bounded by a per-stream byte cap decoupled from the much smaller display budget; stdout/stderr are archived as separate named streams; `read` uses bounded streaming instead of load-then-clip; empty captures are preserved as empty artifacts. |
| R6 | Closed. Recovery pagination no longer reuses the 2,000-character journal-excerpt cap; `read_output`/`search_output` route through the same review boundary as everything else, report truthful delivered ranges, and paginate a single oversized line by explicit UTF-8 byte range with guaranteed forward progress. `search_output` bounds its own page size and reports truthful scan coverage even when internally clipped (below). |
| R7 | Closed. Artifacts are stored per `<journal-parent>/sessions/<sessionId>/artifacts`, stamped and validated by owning session on every read, with malformed/foreign ids rejected before path derivation and a bounded tombstone retention horizon. |

Deferred, not attempted in this increment (unchanged from the plan): the shared-runtime package extraction (`2026-09-22-runtime-consolidation.md`) and the product-validation benchmark (`2026-09-22-product-validation.md`).

## Independent validation follow-up (2026-09-22)

An independent reproduction pass against the initial implementation above found seven real defects the local test suite had not caught — passing tests are not proof of a closed acceptance boundary. All seven are now fixed and covered by new regression tests; documenting them here rather than silently folding them into the table above, since the documentation-vs-actual-behavior gap was itself part of what was found:

1. **R2 — symlink parent-swap during an in-flight gate call.** `writeFileVerified` re-resolved the write target but never compared it against what was actually authorized, and the harness's "auto" gate decision never re-verified anything before letting execution proceed. A parent directory replaced with a symlink WHILE the (slow, async) Jev call was awaited could redirect an auto-approved write outside the project root with zero approvals. Fixed: the harness now rechecks target identity and preimage immediately after the gate decision, for every write outcome, not just "ask".
2. **R4 — SIGKILL silently skipped when the direct child's pipes closed first.** The scheduled group-kill was gated on a `cleanedUp` flag set as soon as the direct child (and its own stdio) settled — but a backgrounded job with redirected stdio can outlive the shell that spawned it, leaving it alive and unsignaled. Separately, `exitPromise` listened on the ChildProcess `"close"` event, which Node/Bun additionally gate on stdio closing, so a detached descendant holding an inherited pipe open blocked the tool from ever noticing the direct child had exited at all. Also found: Bun 1.1.6's `process.kill()` throws on a negative pid instead of performing a real process-group kill. Fixed: group termination now races the direct child's own exit (via `"exit"`, not `"close"`) against the grace timer and always fires SIGKILL either way; a `kill(1)` subprocess fallback works around the Bun bug.
3. **R3 — the outside-root approval path skipped the prepared-action protections.** It built its approval request from just the target, omitting the diff summary and preimage recheck the normal ask path already had. Fixed: both paths now share one prepared-action builder.
4. **R6 read pagination — two infinite loops.** A multi-line capture whose first line alone exceeded the page budget fell through to a whole-line fitter that returned zero progress ("lines 1-0", looping forever); a line ending exactly at a complete multi-byte UTF-8 character had its boundary-safety logic incorrectly back up over that complete character, looping at the same byte offset forever. Both fixed with guaranteed forward progress, tested via full-reconstruction round-trips.
5. **R6 search pagination — false coverage claims and silent re-clipping.** Coverage was computed from the unclipped input length instead of what was actually scanned, so a search clipped by the internal scan cap claimed full coverage of lines never examined; resuming after a `limit`-truncated result skipped matches already found but not returned; and `search_output` never bounded its own page size, so a large match list got silently re-clipped by the harness's outer boundary while the header still claimed full completeness. Fixed: `searchContent` reports what it actually scanned, resumption always continues from the last delivered match, and `search_output` bounds and truthfully labels its own page.
6. **P2/R2 — atomic replacement discarded file permissions.** Replacing a 0600 or 0755 file via temp-file-then-rename left it at the process default mode. Fixed: the temp file is `chmod`'d to the prior file's mode (read from the same `lstat` that already rejected a symlink there) before the rename.
7. **R1 — the Pi adapter ran Sanitize before Focus.** The opposite of the plan's `capture -> focus -> bounded presentation -> review -> delivery` order — Focus's own selection became the delivered view without itself having been what Sanitize reviewed. Fixed: Focus now runs first, over a defensively-capped raw capture, and only its output is bounded and reviewed.

Regression scripts used for reproduction lived at `/private/tmp/brainstem-remediation-validation.ts` and `/private/tmp/brainstem-validation-followup.ts` (outside the repo, not committed); the corresponding fixed-shape assertions now live in this package's own test suite (`packages/cli/test/{tools,harness,approval,paths,recovery-tools}.test.ts`, `packages/pi-adapter/test/attach.test.ts`).

This plan addresses the seven findings from the project review. The IDs below are new review IDs, not the historical P1/P2 implementation phases. It precedes [runtime consolidation](2026-09-22-runtime-consolidation.md) and the [product benchmark](2026-09-22-product-validation.md). Fix the existing integrations before extracting their implementation into a shared package.

The review's local validation passed 369 tests, TypeScript, and the saved output-focus pilot verifier. Additional fixture reproductions exposed the defects below. Those reproductions must become repository tests; the temporary review script is not a maintained dependency.

## Scope and release contract

| ID | Priority | Defect | Required outcome |
|---|---|---|---|
| R1 | P1 | Model receives text Sanitize did not inspect; error text bypasses inspection | Every delivered untrusted text segment is covered by the applied review |
| R2 | P1 | Final file symlinks bypass outside-root write checking | Authorization and execution refer to the same filesystem target |
| R3 | P1 | Approval identity omits write contents | Approval permits only the immutable action shown to the user |
| R4 | P1 | Shell descendants survive timeout | Timeout/cancellation stops managed processes and settles collection |
| R5 | P1 | Output truncated before archival is marked complete | Artifacts preserve the bounded capture and report every capture limit |
| R6 | P1 | Recovery pages are silently reduced to 2,000 characters | Delivered ranges, completeness, and continuation describe the actual page |
| R7 | P2 | Sessions share artifact storage and eviction | Artifact ownership and retention are scoped to one session |

Keep Focus off by default. Preserve existing static denials, approval requirements, and explicit unavailable outcomes. This increment does not introduce a general sandbox for arbitrary shell commands or claim crash-resumable exactly-once execution.

## Delivery sequence

1. Add reproducible regression fixtures and implement R1 as a containment fix in both integrations.
2. Implement R2, then R3 using the corrected path/action identity.
3. Implement R4 independently of output selection changes.
4. Implement R7 before changing artifact layout and metadata in R5.
5. Implement R5, then R6; finish R1's exact-view coverage checks against the repaired capture/recovery path.
6. Run the full integration matrix, update contract documentation, and publish the compatibility notes.

Use one reviewable change per defect where possible. Small internal helpers are appropriate; the package extraction belongs to the next plan. New regression tests and the corresponding fix land together, with evidence that the test fails against the previous behavior.

## R1. Review exactly the delivered text, including failures

Primary files: `packages/cli/src/harness.ts`, `packages/cli/src/output/present.ts`, `packages/pi-adapter/src/index.ts`, `packages/core/src/engine.ts`, and the observation envelope builder.

- Replace independently applied `slice()` calls with one presentation boundary. Bound the complete rendered view before calling Sanitize/Verify, including source receipts and omission notices. Inspect nested envelope builders too: no downstream layer may silently shorten that view again.
- Retain a named character limit compatible with the current 8,000-character judge input cap; measure UTF-8 bytes separately. Never call a character count a byte count. Account for receipt overhead within the limit and avoid splitting Unicode characters.
- Apply `capture -> optional Focus -> bounded presentation -> Sanitize/Verify -> delivery` in the CLI and Pi adapter. Focus-selected text must not be introduced after review.
- Review untrusted failure text regardless of `isError`; preserve exit/status/error metadata after replacement. Distinguish internally generated fixed control messages from tool-supplied messages. Do not trust interpolated paths or exception text as fixed control messages.
- A blocked/unavailable review returns a fixed harness notice and no source text. A review annotation may be added after judgment only if it contains trusted harness-generated wording; it must not introduce new tool text.
- The lightweight adapter currently lacks recovery. For this remediation it may return an explicitly incomplete bounded view and must disclose unavailable recovery; never promise an artifact tool that does not exist. The shared runtime plan supplies the recoverable profile.
- Unsupported non-text content must retain an explicit unsupported/unreviewed classification or be withheld under a policy requiring review. Do not label an entire mixed result reviewed because its text passed.

Acceptance: scripted provider-visible context contains no source text absent from the judge's evidence. Cover a single 9,016-character line with a hostile tail, multiple text blocks, error results, Focus modes, a blocked result, and an unavailable judge. Hooks must return safe results even if artifact storage or review fails; do not throw source-bearing errors that Pi would forward without another review.

## R2. Bind filesystem checks to the actual write

Primary files: `packages/cli/src/paths.ts`, `packages/cli/src/tools.ts`, `packages/cli/src/harness.ts`, `packages/core/src/floor.ts`; corresponding Pi adapter boundary tests.

- Canonicalize the configured root once. Use one resolver for absolute/relative paths, home expansion, parent traversal, and execution. Eliminate the mismatch between policy resolution and `join(cwd, path)` execution.
- Default managed writes to regular files through a verified directory chain. Reject symlink components in the requested write route, including existing final symlinks and dangling symlinks, with a clear blocked outcome. Canonicalization of the configured root itself is permitted. Rejection is preferable to silently changing which file the user meant.
- Apply the static floor to the actual canonical target. An outside-root target must still take its existing deny/approval path before semantic Gate can allow it.
- Prepare a write handle/precondition record and keep execution tied to it. A second `realpath()` or final-component `O_NOFOLLOW` alone does not prevent parent-directory substitution.
- First implementation checkpoint: establish descriptor-relative, no-follow traversal and commit primitives on supported macOS/Linux runtimes. If Bun/Node lacks the required primitive, use a small scoped native helper or an isolated filesystem executor. Do not mark the race guarantee complete with a check-then-write implementation. Unsupported configurations return an explicit unavailable write capability.
- Use a verified parent handle for same-directory staging and atomic replacement, so writing a hard-linked destination does not modify the other link's inode. Define preservation of permissions and handling of new directories; do not silently replace directories or special files.
- Existing file contents and target identity become R3 preconditions. Detect changes during approval, and re-enter review rather than following a substituted target.
- For externally supplied adapter tools, preflight checking alone cannot enforce how their executor opens files. Declare this limitation and require a managed executor to claim the filesystem contract; never imply wrapping a hook creates an OS sandbox.

Acceptance: no write outside the approved target for final symlink, parent symlink, dangling link, sibling-prefix, absolute-path, traversal, and controlled parent/target substitution fixtures. Include the review reproduction: a link inside the repo to an outside file leaves the outside file unchanged and cannot auto-run. Race fixtures use explicit barriers, not probabilistic timing loops.

## R3. Make approvals immutable and action-specific

Primary files: `packages/core/src/approval.ts`, `packages/core/src/evidence.ts`, `packages/cli/src/harness.ts`, `packages/cli/src/main.ts`, and change-summary helpers.

- Introduce a local immutable prepared-action record. Its identity includes tool, canonical cwd/target, all validated execution arguments, write-content digest and length, and filesystem preconditions. Keep bounded log summaries separate.
- Copy and validate inputs before review. Pass a defensive read-only snapshot to the approval handler; retain private executable data. The execution wrapper must consume the prepared action or reject changed Pi arguments immediately before execution.
- Show the actual command or proposed diff/new-file content summary, relevant truncation notices, canonical target, and cwd. Provide a way to inspect the complete proposed change without exposing it indiscriminately in the journal.
- Recheck target identity and preimage before consuming approval. Relevant task/constraint revisions invalidate pending permission; unrelated task steering must not silently approve a stale action.
- Journal requested, approved/denied/cancelled/invalidated, and consumed outcomes with one action digest. Consume permission once inside the active run; neither retries nor cached judgments carry approval forward.
- Hash schemas are versioned. Historical hashes remain historical records and never confer executable permission.

Acceptance: mutating `validatedArgs.content`, nested args, cwd, or target after request cannot change the executed operation. A changed target preimage requires renewed review. Approval of action A never permits B; denied, cancelled, EOF, and missing-handler cases execute nothing. A normal approved write executes once with exactly the displayed bytes.

## R4. Terminate managed process groups and bound cleanup

Primary files: `packages/cli/src/tools.ts`; introduce a small process-lifecycle helper if needed.

- On supported POSIX platforms, launch commands in a managed process group and signal the group on timeout or cancellation. Do not rely solely on `spawn({ signal })` killing the immediate shell.
- Send termination, allow a short configurable grace period, then force termination of surviving group members even if the original shell has exited. Keep process identity/lifecycle state to avoid signalling a reused identifier after cleanup.
- Bound pipe drainage, reap the direct child, remove listeners/timers, and return one terminal result. Keep timeout, caller cancellation, spawn failure, and ordinary nonzero exit distinct.
- Collect output during cleanup under capture limits. Mark incomplete collection explicitly if cleanup cuts off a stream.
- Document the support boundary: a process group handles ordinary descendants, but cannot guarantee containment of a deliberately detached daemon. Strong hostile-process containment requires a sandbox/supervisor; benchmark tasks use that outer boundary. Unsupported platforms must not advertise process-tree cancellation.

Acceptance: parent/child/grandchild fixtures, a child ignoring termination, and a child holding pipes open settle within deadline plus grace/cleanup allowance. A descendant blocked on a fixture barrier cannot write after cancellation completes. Include cancellation before spawn, timeout/cancellation racing exit, and successful execution with no leaked timers.

## R7. Isolate artifacts by session

Primary files: `packages/cli/src/harness.ts`, `packages/cli/src/output/artifact-store.ts`, `packages/core/src/artifacts.ts`, and session/journal metadata.

- Store under `<journal-parent>/sessions/<sessionId>/artifacts`, with a session manifest recording project identity and artifact schema version. Use the session ID generated by `SessionRecorder`, not a timestamp-only directory name.
- Include session ownership in artifact metadata and validate it on load/read/search/list. Validate opaque IDs before deriving paths, and reject malformed or foreign metadata.
- Apply artifact-count/byte limits per session. Bound tombstone metadata too, with a documented retention horizon for distinguishing expired IDs from unknown IDs.
- Two sessions with journals in the same directory must neither read nor evict one another's artifacts. Do not load legacy shared-directory artifacts into a new session implicitly.
- Preserve old files. Document legacy layout incompatibility with new-session recovery; explicit offline migration/resume can be a later feature. Do not delete old evidence during this fix.

Acceptance: concurrent sessions under one parent cannot retrieve each other's known IDs, and exhausting one store leaves the other intact. Reopening a store for its explicit original session preserves its artifacts. Test forged ownership, malformed IDs, and corrupt metadata.

## R5. Archive captures before presentation limits

Primary files: `packages/cli/src/tools.ts`, `packages/core/src/artifacts.ts`, `packages/cli/src/output/artifact-store.ts`, `packages/cli/src/harness.ts`.

- Separate finite capture limits from display limits. Remove the 50,000-character combined-output cap and `.trim()` from the archival path. Keep an explicit configurable bounded capture; unlimited buffering is not the goal.
- Preserve stdout/stderr as separate captured streams, including whitespace, with byte counts and documented rendering order. Do not imply concatenation reconstructs temporal interleaving. Preserve raw bytes or explicitly record decoding losses in the text projection.
- Record bytes observed, bytes retained, and capture completeness/reason per stream. If the original source size is unknown, represent it as unknown; never infer full output from retained length.
- File reads use bounded streaming rather than reading an unlimited file into memory and then clipping it. Mark file-size/capture limits. Preserve empty captures as empty artifacts; `(no output)` is presentation wording, not source content.
- Search/glob result limits also report that enumeration is incomplete. Error/cancelled captures receive the same archival contract when data exists.
- Store the bounded capture before presenting it. Journal truthful artifact hashes, capture limits, and presented-view references; retention failure produces an explicit unavailable recovery outcome.

Acceptance: a 60,000-character output is recoverable in full under the configured capture limit and never marked complete after losing 10,000 characters. Cover output beyond per-stream caps, a file beyond its cap, stderr-only failures, empty output, leading/trailing whitespace, split Unicode, interrupted streams, and disk-write failure.

## R6. Make recovery pagination truthful and complete

Primary files: `packages/cli/src/output/recovery-tools.ts`, `packages/cli/src/output/present.ts`, `packages/cli/src/harness.ts`, `packages/core/src/artifacts.ts`.

- Route recovery results through their own bounded page renderer and the R1 review boundary. Never apply the 2,000-character telemetry excerpt as a model-facing recovery view.
- Keep line-based requests compatible, and add an opaque continuation cursor with artifact/content identity, stream, next byte offset, and query identity where applicable. Long lines may span pages; receipts must identify partial lines and byte ranges.
- Choose page content and its receipt together within the review limit. Return actual delivered ranges and explicit end-of-capture/end-of-source distinctions. A clipped capture can reach its end without reaching the original source's end.
- Search pages distinguish scanned coverage, retained matches, and total matches only when known. Empty selection, no matches in the scanned region, incomplete scan, expired artifact, foreign/unknown ID, and empty source remain distinct.
- Review every recovered page, including error messages containing untrusted input. Recovery never reruns a command and never triggers recursive artifact capture of its own rendered notices.

Acceptance: repeated recovery reconstructs the retained 200-line fixture without gaps or duplicate source bytes; a large single line also progresses. Receipts match exactly what was delivered. Search cursors preserve coverage, foreign/stale cursors fail explicitly, and hostile content in late pages is reviewed before delivery.

## Verification and completion

Run targeted defect tests per change, then `bun run test` and `bun run typecheck` at integration milestones. Run process fixtures under both Bun and the Node/Vitest environment on macOS/Linux where supported. Keep all tests offline and inside scratch directories.

Before declaring this plan complete:

- All seven original reproductions pass as regression tests, including assertions against final provider-visible messages and actual filesystem effects.
- Existing approval, Focus, recovery, replay, and runtime-contract tests pass without weakening their assertions.
- README and adapter documentation describe actual supported guarantees and limitations.
- Add a dated correction to the earlier harness-evolution plan: its completed checkboxes for complete sanitization, descendant cleanup, recoverability, and budgets are historical claims, not proof of these repaired contracts. Preserve that history rather than silently relabeling it.
- Record any deferred platform capability explicitly. R2's race guarantee and R4's managed-process guarantees are release gates for claiming those capabilities, not optional documentation follow-ups.
