// Phase 0 / Experiment 1: verify TypeSafe API access.
// Exit: auth works, model list includes jev, one tiny call returns a sane answer.

import { noul } from "@typesafe-ai/sdk";
import { getClient, MODEL } from "./lib";

const client = getClient();

const models = await client.models.list();
console.log("available models:", models.map((m) => m.name).join(", "));

const t0 = performance.now();
const result = await client.systemOne({
  state: { note: "The quick brown fox jumps over the lazy dog." },
  questions: { mentions_animal: noul("Does `note` mention an animal?") },
  model: MODEL,
});
const ms = performance.now() - t0;

console.log("answered by:", result.model);
console.log("mentions_animal noul:", result.answers.mentions_animal.noul);
console.log("usage:", result.usage);
console.log("latency_ms:", ms.toFixed(0));
