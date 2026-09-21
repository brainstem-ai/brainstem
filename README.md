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

## Approvals today

The gate's "ask" decision returns a blocked tool result telling the agent to ask the user. The full interactive approval lifecycle lands in P3.

## Replay

```sh
bun packages/cli/src/main.ts replay <journal.ndjson> [--trust N]
```

Re-scores recorded judgments offline. Limitations: static-floor denials have no recorded judgment; side effects are never replayed.

## Versions

The `@earendil-works/pi-*` dependencies (0.86.1) are pinned deliberately; upgrades are explicit checks.