# @brainstem/pi-adapter

Wires [`@brainstem/reflexes`](../reflexes) into a
[Pi](https://github.com/earendil-works/pi-agent-core) `Agent` — one function
call, no wrapper agent, no fork of Pi's loop.

## Install

```bash
npm install @brainstem/pi-adapter @brainstem/reflexes
```

## Usage

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { createReflexes, jevJudge } from "@brainstem/reflexes";
import { attachReflexes } from "@brainstem/pi-adapter";

const agent = new Agent({ /* ...your existing Pi agent config... */ });

const reflexes = createReflexes({ judge: jevJudge({ apiKey: process.env.JEV_API_KEY }) });

attachReflexes(agent, reflexes, {
  cwd: process.cwd(),
  taskText: () => currentTaskDescription,
  onReflex: (line) => console.log(line),
});
```

That's it — `agent` now runs Gate before `bash`/`read`/`write`/`grep`/`glob`
calls (configurable via `capturedTools`) and Sanitize + Verify on their
results.

## How it composes

`attachReflexes` wraps whatever `beforeToolCall`/`afterToolCall` the agent
already has — it never replaces them. An existing `block` result is always
respected (a reflex never overrides an existing block, and never spends a
judge call on a call that's already refused). Calling `attachReflexes` twice
on the same agent composes twice; that's correct, if wasteful, behavior.

## Focus (optional, off by default)

```ts
attachReflexes(agent, reflexes, {
  cwd: process.cwd(),
  focusMode: "on",
  recentActivity: () => recentFindingsList,
});
```

With `focusMode: "on"`, large tool results are cut down to the sections Focus
judges relevant to the task — the model only sees the reduced view.

**This is a real limitation, not a caveat to skim past:** this package has no
artifact store and no recovery tool. Content Focus omits is gone for that
turn — there's no `read_output`/`search_output` the model can call to get it
back, unlike brainstem's full CLI harness. Use `focusMode: "on"` only if
losing omitted content is acceptable for your use case, or build your own
recovery path on top of `reflexes.focus()` directly.

## No approval lifecycle

A Gate `ask` verdict is blocked outright, with a reason explaining why — this
package does not implement interactive human approval. If you need that,
call `reflexes.gate()` yourself and build the approval flow you want, or use
brainstem's full CLI harness, which has one.

## License

MIT — see the repo root [LICENSE](../../LICENSE).
