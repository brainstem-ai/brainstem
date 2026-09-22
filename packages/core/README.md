<img src="../../assets/icon.svg" alt="" width="32" height="41">

# @brainstem/core

The reflex engine underneath brainstem. Most consumers should use
[`@brainstem/reflexes`](../reflexes) instead — this package is the low-level
foundation: the `SystemOne` judge interface, `ReflexEngine`, policy, the
journal format, and the bitmap/section utilities that back Focus.

## What's here

- **`SystemOne`** — the judge interface every reflex asks questions through:
  `{ name, ask(state, questions, options) => Promise<AskResult> }`. Implement
  this against any model.
- **`ReflexEngine`** — orchestrates Gate, Sanitize, Verify, Pulse, Steer, and
  Focus over a `SystemOne`, a `Policy`, and a `Journal`.
- **`policyForTrust(trust)`** — safety thresholds that scale with a single
  trust dial (0–1), rather than exposing a pile of independent knobs.
  Thresholds near the safety-critical end are trust-invariant by design.
  See `src/policy.ts`.
- **`openJournal` / `loadJournal`** — a schema-versioned NDJSON decision log,
  replayable offline via `@brainstem/cli`'s replay tooling (not published here).
- **`splitIntoSections` / `CapabilityBitmap`** — structural output splitting
  and the LSB0 bitmap format Focus uses to mark which sections were selected.

## Stability

This package's API surface is broader and less stable than `@brainstem/reflexes`.
If you're building on brainstem, start with `@brainstem/reflexes` and only reach
into `core` directly if you need something the higher-level API doesn't expose.

## License

MIT — see the repo root [LICENSE](../../LICENSE).
