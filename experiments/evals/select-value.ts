#!/usr/bin/env bun
// Live test of Select's actual value — makes REAL API calls (real cost, one
// batched Jev call). Not part of `bun run test`; run with `bun run eval:select`.
//
// The question this answers: does registering several optional tools and
// letting Select judge relevance actually keep irrelevant ones out of what
// the model sees, without the model ever having to reason about them itself?
// This is one scenario with five decoy tools and one genuinely relevant one,
// not a general benchmark.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ReflexEngine, jevSystemOne, openJournal, toIds } from "@brainstem/core";
import { CapabilityRegistry, BASELINE_TOOL_IDS } from "../../packages/cli/src/capabilities/registry";
import { SelectDriver } from "../../packages/cli/src/capabilities/select-policy";

const TASK = "Post a short summary of today's git commits to the team's #eng Slack channel.";

// One genuinely relevant optional tool, four decoys with plausible-sounding
// names and descriptions — the kind of registry a real deployment with many
// integrations would actually have.
const CANDIDATES: { id: string; description: string; useWhen: string[]; avoidWhen: string[]; relevant: boolean }[] = [
  {
    id: "tool:send_slack_message",
    description: "Post a message to a Slack channel.",
    useWhen: ["The task asks to notify, post, or share something in Slack or with a team channel"],
    avoidWhen: ["No Slack channel or team notification is mentioned"],
    relevant: true,
  },
  {
    id: "tool:query_database",
    description: "Run a read-only SQL query against the production analytics database.",
    useWhen: ["The task asks for data that lives in the analytics database"],
    avoidWhen: ["The task doesn't mention querying stored data"],
    relevant: false,
  },
  {
    id: "tool:deploy_to_prod",
    description: "Trigger a production deployment of the current build.",
    useWhen: ["The task explicitly asks to deploy or release to production"],
    avoidWhen: ["No deployment is requested"],
    relevant: false,
  },
  {
    id: "tool:generate_pdf_report",
    description: "Render a structured report as a downloadable PDF.",
    useWhen: ["The task asks for a PDF or printable report"],
    avoidWhen: ["No document generation is requested"],
    relevant: false,
  },
  {
    id: "tool:convert_currency",
    description: "Convert an amount between two currencies at the current exchange rate.",
    useWhen: ["The task involves a monetary amount that needs currency conversion"],
    avoidWhen: ["No currency conversion is needed"],
    relevant: false,
  },
];

function schemaBytesFor(ids: readonly string[]): number {
  // A rough, honest proxy for prompt overhead: how many bytes it takes to
  // describe this tool set to the model (id + description), not a real
  // tokenizer count.
  const described = CANDIDATES.filter((c) => ids.includes(c.id)).map((c) => ({ name: c.id, description: c.description }));
  return JSON.stringify(described).length;
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set (see brainstem/.env).");
    process.exit(1);
  }

  const registry = new CapabilityRegistry();
  for (const c of CANDIDATES) {
    registry.register(
      {
        id: c.id,
        kind: "tool",
        version: "1.0.0",
        description: c.description,
        useWhen: c.useWhen,
        avoidWhen: c.avoidWhen,
        alwaysAvailable: false,
      },
      { name: c.id, execute: async () => ({ content: [] }) },
    );
  }

  const cwd = mkdtempSync(join(tmpdir(), "brainstem-select-"));
  const journal = openJournal(join(cwd, "journal.ndjson"));
  const systemOne = jevSystemOne(new TypeSafeClient());
  const engine = new ReflexEngine({ systemOne, journal, root: cwd });
  const driver = new SelectDriver({ registry, engine });

  console.log("=== Select value: does it keep irrelevant tools out of the model's view? ===");
  console.log(`Task: "${TASK}"`);
  console.log(`Registered ${CANDIDATES.length} optional tools: 1 relevant (send_slack_message), 4 decoys.\n`);

  const catalog = registry.snapshot();
  const allIds = catalog.entries.map((d) => d.id);
  const baselineIds = [...BASELINE_TOOL_IDS];

  console.log("WITHOUT Select (naive: every registered tool is always exposed):");
  console.log(
    `  tool count: ${allIds.length} (${baselineIds.length} baseline + ${CANDIDATES.length} optional, ALL shown regardless of relevance)`,
  );
  console.log(
    `  approx. schema bytes for the optional set: ${schemaBytesFor(catalog.entries.map((d) => d.id).filter((id) => !baselineIds.includes(id as never)))}`,
  );
  console.log("  the model must itself notice that 4 of these 5 tools are irrelevant, every single turn.\n");

  console.log("WITH Select (one real Jev judgment per optional tool, batched):");
  const decision = await driver.refresh({ task: TASK, recent: [] }, { reason: "initial" });
  const ws = registry.workingSet({}, { evaluated: decision.evaluated, recommended: decision.recommended });
  const activeIds = toIds(ws.active, catalog.entries);
  const activeOptional = activeIds.filter((id) => !baselineIds.includes(id as never));

  console.log(`  status: ${decision.status}, batches: ${decision.batches}`);
  for (const c of CANDIDATES) {
    const included = activeOptional.includes(c.id);
    const reason = decision.reasons[c.id];
    const score = decision.scores[c.id];
    const correct = included === c.relevant ? "correct" : "WRONG";
    console.log(
      `  ${included ? "[included]" : "[excluded]"} ${c.id} — score=${score?.toFixed(2) ?? "n/a"} reason=${reason?.kind ?? "?"} (${correct}, expected ${c.relevant ? "included" : "excluded"})`,
    );
  }
  console.log(
    `  tool count actually exposed to the model: ${activeIds.length} (${baselineIds.length} baseline + ${activeOptional.length} optional)`,
  );
  console.log(`  approx. schema bytes for the optional set: ${schemaBytesFor(activeOptional)}`);

  const allCorrect = CANDIDATES.every((c) => activeOptional.includes(c.id) === c.relevant);
  console.log(`\n=== Summary ===`);
  console.log(`Select correctly classified all ${CANDIDATES.length} candidates: ${allCorrect ? "YES" : "NO"}`);
  console.log(
    `Optional-tool schema bytes: ${schemaBytesFor(allIds.filter((id) => !baselineIds.includes(id as never)))} (naive) -> ${schemaBytesFor(activeOptional)} (with Select)`,
  );
  console.log("\nThis is one scenario, one real judgment call — a real demonstration, not a");
  console.log("statistical claim. Re-run for more confidence; a larger real registry would");
  console.log("show a larger absolute reduction.");

  rmSync(cwd, { recursive: true, force: true });
}

main();
