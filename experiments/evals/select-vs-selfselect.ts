#!/usr/bin/env bun
// Live test: does Select actually beat a raw agent self-selecting from a
// large, ambiguous tool list — not just "does Select alone get it right."
// Makes REAL API calls (real cost: several full agent turns + one batched
// Jev call). Not part of `bun run test`; run with `bun run eval:select-vs-self`.
//
// Design: ~26 optional tools registered, only one genuinely correct for the
// task, four deliberate near-misses in the same domain (other messaging
// channels), and ~21 unrelated decoys padding the registry to a realistic
// large size. Three real measurements:
//   1. A raw Pi Agent (same tools/model, zero Jev) given ALL tools — which
//      tool does it actually call, across several repeated runs?
//   2. Select alone (one batched Jev call) — does it correctly narrow the
//      set to just the relevant tool, excluding the near-misses?
//   3. A harnessed agent given the Select-filtered set — does it reliably
//      call the right tool once the decoys are gone?
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ReflexEngine, jevSystemOne, openJournal, toIds } from "@brainstem/core";
import { createHarness, DEFAULT_SYSTEM_PROMPT } from "../../packages/cli/src/harness";
import { makeTools } from "../../packages/cli/src/tools";
import { resolveModels } from "../../packages/cli/src/models";
import { CapabilityRegistry, BASELINE_TOOL_IDS } from "../../packages/cli/src/capabilities/registry";
import { SelectDriver } from "../../packages/cli/src/capabilities/select-policy";
import { CANDIDATES, CORRECT_TOOL, makeStubTool } from "./_fixtures/messaging-registry";

const TASK = "Notify the team in the #eng Slack channel that the nightly build passed.";

function toolNamesCalled(agent: Agent): string[] {
  const names: string[] = [];
  for (const m of agent.state.messages) {
    if (m.role !== "assistant") continue;
    for (const c of (m as { content: { type: string; name?: string }[] }).content ?? []) {
      if (c.type === "toolCall" && c.name) names.push(c.name);
    }
  }
  return names;
}

async function runRawAgentOnce(model: Model<Api>, streamFn: StreamFn): Promise<string[]> {
  const cwd = mkdtempSync(join(tmpdir(), "brainstem-selfselect-"));
  const tools = [...makeTools({ cwd }), ...CANDIDATES.map((c) => makeStubTool(c.name))];
  const agent = new Agent({
    initialState: { systemPrompt: DEFAULT_SYSTEM_PROMPT, model, tools, thinkingLevel: "low" },
    streamFn,
  });
  try {
    await agent.prompt(TASK);
  } catch (err) {
    console.error("  (raw agent run threw:", err instanceof Error ? err.message : err, ")");
  }
  const called = toolNamesCalled(agent);
  rmSync(cwd, { recursive: true, force: true });
  return called;
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY || !process.env.ZAI_API_KEY) {
    console.error("TYPESAFE_API_KEY and ZAI_API_KEY must both be set (see brainstem/.env).");
    process.exit(1);
  }

  const models = createModels();
  const { main: model } = resolveModels(models, process.env.BRAINSTEM_EVAL_MODEL ?? "zai/glm-5.3");
  const streamFn = models.streamSimple.bind(models);

  console.log("=== Select vs self-selection: a large, ambiguous tool registry ===");
  console.log(`Task: "${TASK}"`);
  console.log(
    `Registry: ${CANDIDATES.length} optional tools — 1 correct, 4 same-domain near-misses, ${CANDIDATES.length - 5} unrelated decoys.\n`,
  );

  console.log(`1) RAW AGENT, all ${CANDIDATES.length} tools always exposed (3 repeated runs):`);
  const rawRuns: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const called = await runRawAgentOnce(model, streamFn);
    rawRuns.push(called);
    const verdict =
      called.length === 0
        ? "no tool call"
        : called.includes(CORRECT_TOOL)
          ? `CORRECT (called: ${called.join(", ")})`
          : `WRONG (called: ${called.join(", ")})`;
    console.log(`   run ${i + 1}: ${verdict}`);
  }
  const rawCorrect = rawRuns.filter((c) => c.includes(CORRECT_TOOL)).length;

  console.log(`\n2) SELECT ALONE (one batched Jev call over ${CANDIDATES.length} candidates):`);
  const registry = new CapabilityRegistry();
  for (const c of CANDIDATES) {
    registry.register(
      {
        id: `tool:${c.name}`,
        kind: "tool",
        version: "1.0.0",
        description: c.description,
        useWhen: c.useWhen,
        avoidWhen: c.avoidWhen,
        alwaysAvailable: false,
      },
      makeStubTool(c.name),
    );
  }
  const cwd = mkdtempSync(join(tmpdir(), "brainstem-selfselect-"));
  const journal = openJournal(join(cwd, "journal.ndjson"));
  const systemOne = jevSystemOne(new TypeSafeClient());
  const engine = new ReflexEngine({ systemOne, journal, root: cwd });
  const driver = new SelectDriver({ registry, engine });
  const decision = await driver.refresh({ task: TASK, recent: [] }, { reason: "initial" });
  const catalog = registry.snapshot();
  const ws = registry.workingSet({}, { evaluated: decision.evaluated, recommended: decision.recommended });
  const activeOptional = toIds(ws.active, catalog.entries).filter((id) => !BASELINE_TOOL_IDS.includes(id as never));

  let selectCorrect = true;
  for (const c of CANDIDATES) {
    const included = activeOptional.includes(`tool:${c.name}`);
    if (included !== c.relevant) selectCorrect = false;
    if (included || c.relevant) {
      console.log(`   ${included ? "[included]" : "[MISSED]"} tool:${c.name} (expected ${c.relevant ? "included" : "excluded"})`);
    }
  }
  console.log(`   total optional tools exposed after Select: ${activeOptional.length} of ${CANDIDATES.length}`);
  rmSync(cwd, { recursive: true, force: true });

  console.log(`\n3) HARNESSED AGENT, given the Select-filtered set (3 repeated runs):`);
  const harnessedRuns: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const hcwd = mkdtempSync(join(tmpdir(), "brainstem-selfselect-h-"));
    const hRegistry = new CapabilityRegistry();
    for (const c of CANDIDATES) {
      hRegistry.register(
        {
          id: `tool:${c.name}`,
          kind: "tool",
          version: "1.0.0",
          description: c.description,
          useWhen: c.useWhen,
          avoidWhen: c.avoidWhen,
          alwaysAvailable: false,
        },
        makeStubTool(c.name),
      );
    }
    const harness = createHarness({
      systemOne: jevSystemOne(new TypeSafeClient()),
      streamFn,
      model,
      trust: 0.3,
      journalPath: join(hcwd, "journal.ndjson"),
      cwd: hcwd,
      registry: hRegistry,
    });
    try {
      await harness.prompt(TASK);
    } catch (err) {
      console.error("  (harnessed run threw:", err instanceof Error ? err.message : err, ")");
    } finally {
      harness.endSession("normal");
    }
    const called = toolNamesCalled(harness.agent);
    harnessedRuns.push(called);
    console.log(
      `   run ${i + 1}: ${called.includes(CORRECT_TOOL) ? "CORRECT" : called.length === 0 ? "no tool call" : `called: ${called.join(", ")}`}`,
    );
    rmSync(hcwd, { recursive: true, force: true });
  }
  const harnessedCorrect = harnessedRuns.filter((c) => c.includes(CORRECT_TOOL)).length;

  console.log("\n=== Summary ===");
  console.log(`Raw agent (all ${CANDIDATES.length} tools shown): ${rawCorrect}/3 runs called the correct tool`);
  console.log(`Select alone: correctly classified all ${CANDIDATES.length} candidates: ${selectCorrect ? "YES" : "NO"}`);
  console.log(`Harnessed agent (Select-filtered): ${harnessedCorrect}/3 runs called the correct tool`);
  console.log("\nThree runs each is a small sample, not a statistical guarantee — re-run for");
  console.log("more confidence. This tests one task/registry shape, not tool selection in");
  console.log("general.");
}

main();
