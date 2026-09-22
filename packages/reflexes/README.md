<img src="../../assets/icon.svg" alt="" width="32" height="41">

# @brainstem/reflexes

A standalone library of bounded judgment reflexes for coding agents: `gate`
risky tool calls, `observe` tool results for injected instructions and
unsupported claims, and `focus` large output down to what's relevant. Bring
your own judge model — this package has no hard dependency on any one
provider.

## Install

```bash
npm install @brainstem/reflexes
```

## Usage

```ts
import { createReflexes, jevJudge } from "@brainstem/reflexes";

const reflexes = createReflexes({
  judge: jevJudge({ apiKey: process.env.JEV_API_KEY }),
});

// Gate — should this tool call run automatically?
const gate = await reflexes.gate({
  tool: "bash",
  command: "rm -rf build/",
  task: "clean the build directory before rebuilding",
});
if (gate.action === "deny") throw new Error(gate.reasons.join("; "));
if (gate.action === "ask") {
  /* surface gate.reasons to a human before running the command */
}

// Observe — sanitize + verify a tool result after it runs
const observed = await reflexes.observe({
  task: "clean the build directory before rebuilding",
  source: "tool:bash",
  actionSummary: "rm -rf build/",
  status: "ok",
  truncated: false,
  content: toolOutputText,
});
if (observed.sanitize.action === "block") {
  /* toolOutputText looks like it contains injected instructions */
}

// Focus — cut a large tool result down to what's relevant to the task
const focused = await reflexes.focus({
  task: "find where the rate limiter is configured",
  command: "grep -r rateLimit src/",
  outcome: "ok",
  recentFindings: [],
  content: toolOutputText,
});
console.log(focused.text); // only the sections judged relevant
```

## Bring your own judge

`jevJudge` uses [Jev](https://typesafe.ai), a small judge model purpose-built
for this kind of bounded decision. If you'd rather use a different model,
implement `SystemOne` yourself, or use `genericJudge` as a reference
implementation against any text-completion function:

```ts
import { createReflexes, genericJudge } from "@brainstem/reflexes";

const reflexes = createReflexes({
  judge: genericJudge({
    complete: async (prompt) => {
      const response = await myModelClient.complete(prompt);
      return response.text;
    },
  }),
});
```

`genericJudge` synthesizes a fixed `confidence: 1` for every answer — it does
not have Jev's calibrated confidence. Reflexes that lean on confidence (like
Gate's auto/ask/deny thresholds) will behave more conservatively with it.

## Policy

Defaults come from `policyForTrust(0.3)` (from `@brainstem/core`) — a
moderate-trust starting point. Override any top-level section:

```ts
createReflexes({
  judge,
  policy: { gate: { autoConfidence: 0.99 } },
});
```

Policy overrides are shallow-merged — overriding one field of a sub-object
requires passing the whole sub-object.

## Journaling

By default, `createReflexes` keeps no record of decisions. Pass `journalPath`
to durably append every decision as NDJSON (via `@brainstem/core`'s journal
format), or `onDecision` for an in-process callback:

```ts
createReflexes({
  judge,
  journalPath: "./brainstem-journal.ndjson",
  onDecision: (event) => console.log(`[${event.reflex}] ${event.action}`),
});
```

## What this package does not do

- No approval UI or lifecycle — Gate's `ask` outcome is yours to handle.
- No artifact store — `focus`'s omitted content is not recoverable unless you
  keep the original yourself.
- No retries, rate limiting, or circuit breaking beyond what your `SystemOne`
  implementation does.

## License

MIT — see the repo root [LICENSE](../../LICENSE).
