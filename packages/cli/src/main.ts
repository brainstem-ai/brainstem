#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { DEFAULT_TRUST, jevSystemOne, loadJournal, policyForTrust } from "@brainstem/core";
import { createHarness } from "./harness";
import { replayJournal } from "./replay";

interface Args {
  trust: number;
  model: string;
  miniModel: string;
  journal: string;
  task?: string;
  cwd: string;
  help: boolean;
}

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    trust: DEFAULT_TRUST,
    model: "zai/glm-5.3",
    miniModel: "zai/glm-5.3-flash",
    journal: `~/.brainstem/journal-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.ndjson`,
    cwd: process.cwd(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--trust") args.trust = Number(argv[++i]);
    else if (a === "--model") args.model = argv[++i] ?? args.model;
    else if (a === "--mini-model") args.miniModel = argv[++i] ?? args.miniModel;
    else if (a === "--journal") args.journal = argv[++i] ?? args.journal;
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--cwd") args.cwd = argv[++i] ?? args.cwd;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function runReplay(argv: string[]): void {
  const journalPath = argv[0] ? expandHome(argv[0]) : undefined;
  if (!journalPath) {
    console.error("usage: brainstem replay <journal.ndjson> [--trust 0..1]");
    process.exit(1);
  }
  let trust = DEFAULT_TRUST;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--trust") trust = Number(argv[i + 1]);
  }
  const events = loadJournal(journalPath);
  const report = replayJournal(events, policyForTrust(trust));
  console.log(`replay: ${events.length} events, trust ${trust}`);
  console.log(`decisions re-scored: ${report.total}  unchanged: ${report.unchanged}  changed: ${report.changed.length}`);
  for (const c of report.changed) {
    console.log(`  ${c.reflex} [${c.subject}] ${c.was} -> ${c.now}: ${c.reasons.join("; ")}`);
  }
}

function renderReflex(line: string): string {
  if (line.startsWith("[gate] deny")) return `${RED}${line}${RESET}`;
  if (
    line.startsWith("[gate] ask") ||
    line.startsWith("[sanitize] review") ||
    line.startsWith("[sanitize] block") ||
    line.startsWith("[pulse] intervene") ||
    line.startsWith("[pulse] stop")
  ) {
    return `${YELLOW}${line}${RESET}`;
  }
  return `${DIM}${line}${RESET}`;
}

async function main() {
  if (process.argv[2] === "replay") {
    runReplay(process.argv.slice(3));
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`brainstem — a dual-brain agent harness

Usage:
  brainstem [--trust 0..1] [--model provider/id] [--mini-model provider/id]
            [--journal path] [--task "..."] [--cwd path]
  brainstem replay <journal.ndjson> [--trust 0..1]

  --trust N        autonomy dial, 0 = ask about everything, 1 = act on confidence (default 0.3)
  --mini-model id  smaller model for steer routing (default zai/glm-5.3-flash)
  --task "..."     one-shot mode: run a single task and exit
  --journal p      NDJSON journal path (reflex answers, decisions, tool calls)
  replay           re-score a recorded journal against a new trust level (no API calls)`);
    return;
  }

  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set (put it in brainstem/.env).");
    process.exit(1);
  }

  const models = createModels();
  const [providerId = "", modelId = ""] = args.model.split("/");
  if (providerId === "anthropic") models.setProvider(anthropicProvider());
  if (providerId === "zai") models.setProvider(zaiProvider());
  const model = models.getModel(providerId, modelId);
  if (!model) {
    console.error(`unknown model ${args.model}`);
    process.exit(1);
  }

  let miniModel: ReturnType<typeof models.getModel> = undefined;
  const [miniProvider, miniId] = args.miniModel.split("/");
  if (miniProvider === providerId) {
    miniModel = model;
  } else {
    if (miniProvider === "anthropic") models.setProvider(anthropicProvider());
    if (miniProvider === "zai") models.setProvider(zaiProvider());
    miniModel = miniId ? models.getModel(miniProvider, miniId ?? "") : undefined;
  }
  if (!miniModel) {
    console.error(`mini model ${args.miniModel} not found — steering disabled`);
  }

  const journalPath = expandHome(args.journal);
  const systemOne = jevSystemOne(new TypeSafeClient());

  console.log(`brainstem · trust ${args.trust} · model ${args.model} · reflexes ${systemOne.name}`);
  console.log(`journal: ${journalPath}`);

  const harness = createHarness({
    systemOne,
    streamFn: models.streamSimple.bind(models),
    model,
    miniModel: miniModel ?? undefined,
    trust: args.trust,
    journalPath,
    cwd: args.cwd,
    onReflex: (line) => console.error(renderReflex(line)),
    onDelta: (delta) => process.stdout.write(delta),
  });

  if (args.task) {
    await harness.prompt(args.task);
    process.stdout.write("\n");
    return;
  }

  console.log("type a task, ctrl+d to exit");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    process.stdout.write("\n");
    await harness.prompt(trimmed);
    process.stdout.write("\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
