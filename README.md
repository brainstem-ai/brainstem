# brainstem

Bounded judgment reflexes for coding agents — a small, pluggable "System 1" that
sits between an agent and its tools: gating risky commands, sanitizing tool
output for injected instructions, verifying claims against evidence, and
focusing large output down to what's relevant. Backed by a lightweight judge
model (Jev) instead of the main agent model, so these checks are cheap, fast,
and auditable independent of whichever model is driving the agent.

## Packages

| Package | What it is |
|---|---|
| [`@brainstem/core`](packages/core) | The reflex engine and types — `SystemOne` judge interface, policy, journal, bitmap/section utilities. The foundation everything else builds on. |
| [`@brainstem/reflexes`](packages/reflexes) | A standalone library wrapping `core` into a simple `createReflexes({ judge })` API — `gate`, `observe` (sanitize + verify), `focus`. Bring your own judge (Jev, or any model via `genericJudge`). |
| [`@brainstem/pi-adapter`](packages/pi-adapter) | Wires `@brainstem/reflexes` into a [Pi](https://github.com/earendil-works/pi-agent-core) `Agent` by composing its `beforeToolCall`/`afterToolCall` hooks — one function call, no wrapper agent. |

## Why

Most harnesses either trust every tool result outright or route every check
through the main model, which is slow and expensive. brainstem's reflexes run
on a small judge model, so the checks that matter — is this command safe to
auto-run, did this tool result get injected with instructions, is this claim
backed by evidence — cost a fraction of a full model turn and log a structured,
replayable decision trail.

## Quick start

```bash
npm install @brainstem/reflexes
```

```ts
import { createReflexes, jevJudge } from "@brainstem/reflexes";

const reflexes = createReflexes({ judge: jevJudge({ apiKey: process.env.JEV_API_KEY }) });

const decision = await reflexes.gate({ tool: "bash", command: "rm -rf build/", task: "clean the build directory" });
if (decision.action === "deny") throw new Error(decision.reasons.join("; "));
```

See each package's README for the full API.

## Using a different judge

`SystemOne` is a small interface (`{ name, ask(state, questions, options) }`) —
implement it against any model. `genericJudge` in `@brainstem/reflexes` is a
reference implementation that works with any text-completion function.

## Development

This is a Bun workspace monorepo.

```bash
bun install
bun run typecheck
bun run test
```

## License

MIT — see [LICENSE](LICENSE).
