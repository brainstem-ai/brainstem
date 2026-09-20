#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { DEFAULT_TRUST, jevSystemOne } from "@brainstem/core";
import { createHarness } from "./harness";

interface Args {
  trust: number;
  model: string;
  journal: string;
  task?: string;
  cwd: string;
  help: boolean;
}

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    trust: DEFAULT_TRUST,
    model: "anthropic/claude-sonnet-4-5",
    journal: `~/.brainstem/journal-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.ndjson`,
    cwd: process.cwd(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--trust") args.trust = Number(argv[++i]);
    else if (a === "--model") args.model = argv[++i] ?? args.model;
    else if (a === "--journal") args.journal = argv[++i] ?? args.journal;
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--cwd") args.cwd = argv[++i] ?? args.cwd;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function renderReflex(line: string): string {
  if (line.startsWith("[gate] deny")) return `${RED}${line}${RESET}`;
  if (line.startsWith("[gate] ask") || line.startsWith("[sanitize] review") || line.startsWith("[sanitize] block")) {
    return `${YELLOW}${line}${RESET}`;
  }
  return `${DIM}${line}${RESET}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`brainstem — a dual-brain agent harness

Usage: brainstem [--trust 0..1] [--model provider/id] [--journal path] [--task "..."] [--cwd path]

  --trust N     autonomy dial, 0 = ask about everything, 1 = act on confidence (default 0.3)
  --task "..."  one-shot mode: run a single task and exit
  --journal p   NDJSON journal path (reflex answers, decisions, tool calls)`);
    return;
  }

  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set (put it in brainstem/.env).");
    process.exit(1);
  }

  const [providerId = "", modelId = ""] = args.model.split("/");
  const models = createModels();
  if (providerId === "anthropic") models.setProvider(anthropicProvider());
  const model = models.getModel(providerId, modelId);
  if (!model) {
    console.error(`unknown model ${args.model}`);
    process.exit(1);
  }

  const journalPath = args.journal.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  const systemOne = jevSystemOne(new TypeSafeClient());

  console.log(`brainstem · trust ${args.trust} · model ${args.model} · reflexes ${systemOne.name}`);
  console.log(`journal: ${journalPath}`);

  const harness = createHarness({
    systemOne,
    streamFn: models.streamSimple.bind(models),
    model,
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
