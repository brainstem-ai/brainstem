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

Implemented: **Gate**, **Sanitize**, **Verify**, **Pulse**, **Steer**
Planned: **Select**, **Focus**

**Tend** is a later checkpoint workflow, not a continuous filter.

What each reflex is shown is as much a part of the contract as what it decides:

| Reflex | Evidence it receives |
|---|---|
| Gate | The real action — the command, or for a write a bounded diff (existing file) or first-40-lines summary (new file), flagged when the evidence is incomplete. The approval hash stays out of it. |
| Sanitize / Verify | One bounded envelope: task, source, action summary, capped intent, status, truncation, and the exact content to be delivered. |
| Pulse | Recent actions with statuses, labelled repeat counts, failure fingerprints, and whether the approach changed — all computed in code. |
| Steer | The latest completed observation and the active capability descriptions. |

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

Without an approval handler (a non-interactive run), an `ask` returns a blocked
tool result telling the agent to ask the user, and the CLI exits nonzero.

## Output artifacts and recovery

Every captured tool result is stored whole as an artifact before any reduced view
is presented, so nothing the model was not shown is lost. Two always-available
tools recover it without rerunning the command:

```
read_output({ id, startLine, lineCount })
search_output({ id, pattern, limit })
```

Responses carry their real source ranges and completeness markers, and pass
through the same sanitize path as any other tool result. Unknown ID, evicted
artifact, capture truncation, and empty source are distinct outcomes — never a
bare "no output". The store is bounded per session and evicts by age.

## Replay

```sh
bun packages/cli/src/main.ts replay <journal.ndjson> [--trust N]
```

Re-scores recorded judgments offline. Limitations: static-floor denials have no recorded judgment; side effects are never replayed.

## Versions

The `@earendil-works/pi-*` dependencies (0.86.1) are pinned deliberately; upgrades are explicit checks.