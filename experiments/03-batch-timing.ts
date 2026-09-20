// Phase 0 / Experiment 3: reflex-batch latency and cost.
// One call per loop step carrying ~21 mixed questions (gate + pulse + steer + tend)
// over a synthetic loop state. Exit: p95 < 800ms, cost < $0.001/step.

import { choice, noul, score } from "@typesafe-ai/sdk";
import { getClient, MODEL, stats, costUsd } from "./lib";

const state = {
  task: "Fix the failing authentication test in src/auth.test.ts",
  working_tree: "3 modified files, uncommitted",
  recent_events: [
    { actor: "user", text: "the auth test is failing on CI, can you fix it?" },
    { actor: "assistant", text: "I'll run the test to see the failure." },
    { actor: "tool", text: "vitest: FAIL src/auth.test.ts - expected 200, received 401" },
    { actor: "assistant", text: "The token isn't attached. Let me check the middleware." },
    { actor: "tool", text: "read src/middleware/auth.ts (94 lines)" },
    { actor: "assistant", text: "Found it: missing bearer header. Applying fix." },
    { actor: "tool", text: "edited src/middleware/auth.ts lines 40-48" },
    { actor: "tool", text: "vitest: FAIL src/auth.test.ts - expected 200, received 401" },
  ],
  pending_action: { tool: "bash", command: "npm test -- auth" },
  budget: { llm_calls: 4, tokens_used: 41000, dollars_used: 0.38, minutes_elapsed: 6 },
};

const chunks = [
  "user: the auth test is failing on CI, can you fix it?",
  "assistant: I'll run the test to see the failure.",
  "tool: vitest: FAIL src/auth.test.ts - expected 200, received 401",
  "assistant: The token isn't attached. Let me check the middleware.",
  "tool: read src/middleware/auth.ts (94 lines)",
  "assistant: Found it: missing bearer header. Applying fix.",
  "tool: edited src/middleware/auth.ts lines 40-48",
  "tool: vitest: FAIL src/auth.test.ts - expected 200, received 401",
  "assistant: The edit didn't fix it. Let me check the test setup.",
  "tool: read src/auth.test.ts (61 lines)",
];

const questions = {
  ...Object.fromEntries([
    ["gate.destructive", score("How destructive is the command in `pending_action.command` if it runs now?", ["Reversible project-file change.", "Moderate effort to restore.", "May be impossible to restore.", "System or production damage."])],
    ["gate.credentials", noul("The command in `pending_action.command` reads, prints, or transmits secrets.")],
    ["gate.exfiltrates", noul("The command in `pending_action.command` sends data to a remote network destination.")],
    ["gate.disposition", choice("What should the harness do with `pending_action.command`?", { auto_run: "Run without asking.", ask_user: "Confirm with the user first.", deny: "Refuse to run it." })],
    ["pulse.repeating", noul("The assistant's recent actions in `recent_events` repeat or closely resemble earlier actions in that list.")],
    ["pulse.progressing", noul("The sequence in `recent_events` shows movement toward completing `task`.")],
    ["pulse.stuck_on_same_error", noul("The same failure appears in `recent_events` after the assistant already attempted a fix.")],
    ["pulse.worth_continuing", score("Given `budget` and `recent_events`, should the agent continue on its own?", ["Stop and ask the user.", "Continue but check in soon.", "Continue autonomously."])],
    ["steer.model_tier", choice("What tier of model should handle the next turn of `task`?", { none: "No LLM call is needed.", mini: "A small, fast model suffices.", frontier: "A frontier model is warranted." })],
    ["steer.needs_model", noul("The next step of `task` requires generating new text or code, rather than running a tool or finishing up.")],
    ["steer.needs_search", noul("The next step of `task` requires searching the codebase or files.")],
    ["verify.last_result_ok", noul("The most recent tool result in `recent_events` satisfies what the assistant was trying to do.")],
    ["verify.same_error_twice", noul("Two or more tool results in `recent_events` show the same error.")],
    ...chunks.map((c, i) => [
      `tend.chunk_${i}`,
      score(`How relevant is this transcript entry to the current work in \`task\`?\n\nEntry: "${c}"`, ["Irrelevant or superseded.", "Background context.", "Directly relevant."]),
    ]),
  ]),
} as Record<string, ReturnType<typeof noul> | ReturnType<typeof score> | ReturnType<typeof choice>>;

const client = getClient();
const latencies: number[] = [];
let tokens = 0;

const RUNS = 10;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const r = await client.systemOne({ state, questions, model: MODEL });
  latencies.push(performance.now() - t0);
  tokens += r.usage.input_tokens;
}

const s = stats(latencies);
console.log(`\n=== REFLEX BATCH: ${Object.keys(questions).length} questions x ${RUNS} runs ===`);
console.log(`latency p50=${s.p50.toFixed(0)}ms p95=${s.p95.toFixed(0)}ms mean=${s.mean.toFixed(0)}ms`);
console.log(`input tokens/call: ${(tokens / RUNS).toFixed(0)}`);
console.log(`cost/step: $${costUsd(tokens / RUNS).toFixed(6)}`);
