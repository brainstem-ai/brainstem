#!/usr/bin/env bun
// Live test: how does Select handle a genuinely ambiguous task, versus a raw
// agent self-selecting? Makes REAL API calls (real cost). Not part of
// `bun run test`; run with `bun run eval:select-ambiguity`.
//
// Same 27-tool registry as select-vs-selfselect.ts (that test used an
// unambiguous task and found no accuracy gap — both approaches got it right
// every time). This one is deliberately harder:
//   - No literal "Slack" or "channel" keyword. The only signal is "#eng",
//     the Slack channel-naming convention, requiring real inference rather
//     than string matching.
//   - A planted distractor: the task explicitly MENTIONS email, in a clause
//     that actually REJECTS it for this instance ("usually we'd email... but
//     this time just ping #eng directly"). A shallow keyword-matcher could
//     latch onto "email" and pick the wrong tool despite the sentence
//     explicitly ruling it out.
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

const TASK =
  "The nightly build just passed. Usually we'd email a summary, but this one's time-sensitive — just ping #eng directly right now instead.";
const RUNS = 5; // more than the prior test's 3 — ambiguity is exactly where run-to-run variance matters most

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
  const cwd = mkdtempSync(join(tmpdir(), "brainstem-ambig-"));
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

function freshRegistry(): CapabilityRegistry {
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
  return registry;
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY || !process.env.ZAI_API_KEY) {
    console.error("TYPESAFE_API_KEY and ZAI_API_KEY must both be set (see brainstem/.env).");
    process.exit(1);
  }

  const models = createModels();
  const { main: model } = resolveModels(models, process.env.BRAINSTEM_EVAL_MODEL ?? "zai/glm-5.3");
  const streamFn = models.streamSimple.bind(models);

  console.log("=== Select vs self-selection under genuine ambiguity ===");
  console.log(`Task: "${TASK}"`);
  console.log(`No literal "Slack"/"channel" keyword. "Email" is mentioned but explicitly rejected — a planted distractor.\n`);

  console.log(`1) RAW AGENT, all ${CANDIDATES.length} tools always exposed (${RUNS} repeated runs):`);
  const rawRuns: string[][] = [];
  for (let i = 0; i < RUNS; i++) {
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
  const rawFellForDistractor = rawRuns.filter((c) => c.includes("send_email")).length;

  console.log(`\n2) SELECT ALONE (${RUNS} repeated batched Jev calls — ambiguity is exactly where score variance matters):`);
  const selectRuns: { included: string[]; scores: Record<string, number> }[] = [];
  for (let i = 0; i < RUNS; i++) {
    const cwd = mkdtempSync(join(tmpdir(), "brainstem-ambig-sel-"));
    const journal = openJournal(join(cwd, "journal.ndjson"));
    const systemOne = jevSystemOne(new TypeSafeClient());
    const engine = new ReflexEngine({ systemOne, journal, root: cwd });
    const registry = freshRegistry();
    const driver = new SelectDriver({ registry, engine });
    const decision = await driver.refresh({ task: TASK, recent: [] }, { reason: "initial" });
    const catalog = registry.snapshot();
    const ws = registry.workingSet({}, { evaluated: decision.evaluated, recommended: decision.recommended });
    const activeOptional = toIds(ws.active, catalog.entries)
      .filter((id) => !BASELINE_TOOL_IDS.includes(id as never))
      .map((id) => id.replace(/^tool:/, ""));
    selectRuns.push({ included: activeOptional, scores: decision.scores });
    const correctScore = decision.scores[`tool:${CORRECT_TOOL}`] ?? decision.scores[CORRECT_TOOL];
    const emailScore = decision.scores["tool:send_email"] ?? decision.scores.send_email;
    console.log(
      `   run ${i + 1}: included=[${activeOptional.join(", ") || "none"}] send_slack_message score=${correctScore?.toFixed(2) ?? "n/a"} send_email score=${emailScore?.toFixed(2) ?? "n/a"}`,
    );
    rmSync(cwd, { recursive: true, force: true });
  }
  const selectCorrect = selectRuns.filter((r) => r.included.includes(CORRECT_TOOL) && !r.included.includes("send_email")).length;
  const selectFellForDistractor = selectRuns.filter((r) => r.included.includes("send_email")).length;

  console.log(`\n3) HARNESSED AGENT, given Select's filtered set each run (${RUNS} repeated runs):`);
  const harnessedRuns: string[][] = [];
  for (let i = 0; i < RUNS; i++) {
    const hcwd = mkdtempSync(join(tmpdir(), "brainstem-ambig-h-"));
    const hRegistry = freshRegistry();
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
  const harnessedFellForDistractor = harnessedRuns.filter((c) => c.includes("send_email")).length;

  console.log("\n=== Summary ===");
  console.log(`Raw agent:       ${rawCorrect}/${RUNS} correct, ${rawFellForDistractor}/${RUNS} fell for the email distractor`);
  console.log(
    `Select alone:    ${selectCorrect}/${RUNS} correct (kept only send_slack_message), ${selectFellForDistractor}/${RUNS} included send_email`,
  );
  console.log(`Harnessed agent: ${harnessedCorrect}/${RUNS} correct, ${harnessedFellForDistractor}/${RUNS} fell for the email distractor`);
  console.log(`\n${RUNS} runs each — small sample, real variance expected. This tests one`);
  console.log("ambiguous task/registry shape, not ambiguity handling in general.");
}

main();
