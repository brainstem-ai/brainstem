#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { DEFAULT_TRUST, jevSystemOne, loadJournal, policyForTrust, type ApprovalHandler, type ApprovalRequest, type ApprovalResolution } from "@brainstem/core";
import { createHarness } from "./harness";
import type { FocusRolloutMode } from "./output/present";
import { resolveModels, type ResolvedModels } from "./models";
import { replayJournal } from "./replay";

interface Args {
  trust: number;
  model: string;
  miniModel: string;
  journal: string;
  task?: string;
  cwd: string;
  skillRoots: string[];
  focusMode: FocusRolloutMode;
  help: boolean;
}

const FOCUS_MODES: readonly FocusRolloutMode[] = ["off", "shadow", "on"];

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
    skillRoots: [],
    focusMode: "off",
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
    else if (a === "--skill-root") {
      const root = argv[++i];
      if (root) args.skillRoots.push(root);
    }
    else if (a === "--focus-mode") args.focusMode = (argv[++i] ?? args.focusMode) as FocusRolloutMode;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function runReplay(argv: string[]): void {
  const journalPath = argv[0] ? expandHome(argv[0]) : undefined;
  if (!journalPath) {
    console.error("usage: brainstem replay <journal.ndjson> [--trust 0..1] [--mode policy|reevaluate]");
    process.exit(1);
  }
  let trust = DEFAULT_TRUST;
  let mode: "policy" | "reevaluate" = "policy";
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--trust") trust = Number(argv[i + 1]);
    else if (argv[i] === "--mode") mode = (argv[i + 1] as "policy" | "reevaluate") ?? mode;
  }
  if (mode === "reevaluate") {
    console.error(
      "live re-evaluation is not implemented — replay only recomputes deterministic decisions from recorded scores. Re-run the task to get a fresh judgment.",
    );
    process.exit(1);
  }
  if (mode !== "policy") {
    console.error(`--mode must be policy or reevaluate, got ${mode}`);
    process.exit(1);
  }

  const events = loadJournal(journalPath);
  const report = replayJournal(events, policyForTrust(trust));
  console.log(`replay: ${events.length} events, trust ${trust}`);
  console.log(`decisions replayed: ${report.total}  unchanged: ${report.unchanged}  changed: ${report.changed.length}`);
  for (const c of report.changed) {
    console.log(`  ${c.reflex} [${c.subject}] ${c.was} -> ${c.now}: ${c.reasons.join("; ")}`);
  }
  console.log(`static-only (no judgment, floor decided): ${report.staticOnly}`);
  if (report.unsupported > 0) {
    console.log(`unsupported: ${report.unsupported}`);
    for (const [reason, count] of Object.entries(report.unsupportedReasons)) {
      console.log(`  ${reason}: ${count}`);
    }
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
            [--journal path] [--task "..."] [--cwd path] [--skill-root path]
  brainstem replay <journal.ndjson> [--trust 0..1] [--mode policy|reevaluate]

  --trust N        confidence bar for auto-running (0 = most cautious, 1 = most autonomous; default 0.3). Safety thresholds never change.
  --mini-model id  smaller model for steer routing (default zai/glm-5.3-flash)
  --task "..."     one-shot mode: run a single task and exit
  --journal p      NDJSON journal path (reflex answers, decisions, tool calls)
  --skill-root p   directory containing skill subdirectories (repeatable)
  --focus-mode m   off (default), shadow (compute + journal, never presented), or on (presented)
  replay           re-score a recorded journal's decisions against a new trust level (no API calls)
                   --mode policy (default) replays deterministically; --mode reevaluate is not implemented`);
    return;
  }

  if (!Number.isFinite(args.trust) || args.trust < 0 || args.trust > 1) {
    console.error(`--trust must be a number between 0 and 1, got ${args.trust}`);
    process.exit(1);
  }
  if (!FOCUS_MODES.includes(args.focusMode)) {
    console.error(`--focus-mode must be one of ${FOCUS_MODES.join("|")}, got ${args.focusMode}`);
    process.exit(1);
  }
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (/-(timeout|deadline)$/.test(a)) {
      const v = Number(process.argv[i + 1]);
      if (!(Number.isFinite(v) && v > 0)) {
        console.error(`${a} must be a positive number, got ${process.argv[i + 1]}`);
        process.exit(1);
      }
    }
  }

  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set (put it in brainstem/.env).");
    process.exit(1);
  }

  const models = createModels();
  let resolved: ResolvedModels;
  try {
    resolved = resolveModels(models, args.model, args.miniModel);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const { main: model, mini: miniModel } = resolved;

  for (const root of args.skillRoots) {
    const resolvedRoot = expandHome(root);
    let stats;
    try {
      stats = statSync(resolvedRoot);
    } catch {
      console.error(`--skill-root does not exist: ${resolvedRoot}`);
      process.exit(1);
    }
    if (!stats.isDirectory()) {
      console.error(`--skill-root is not a directory: ${resolvedRoot}`);
      process.exit(1);
    }
  }

  const journalPath = expandHome(args.journal);
  const systemOne = jevSystemOne(new TypeSafeClient());

  console.log(`brainstem · trust ${args.trust} · model ${args.model} · reflexes ${systemOne.name}`);
  console.log(`journal: ${journalPath}`);

  let pendingApproval: { resolve: (r: ApprovalResolution) => void; reject: (e: Error) => void } | undefined;
  const promptQueue: string[] = [];
  const steerQueue: string[] = [];

  // One input controller, two modes: while an approval is pending, stdin
  // resolves the approval (y/yes/approve → approve_once; n/no/deny or empty →
  // deny; anything else is queued as a task update); otherwise stdin is a task
  // prompt. Approval answers never become task messages and vice versa.
  const approvalHandler: ApprovalHandler = (req: ApprovalRequest) =>
    new Promise<ApprovalResolution>((resolve, reject) => {
      const reqArgs = (req.validatedArgs ?? {}) as { command?: string; path?: string };
      console.error(`[brainstem] approval needed: ${req.tool}`);
      if (reqArgs.command !== undefined) console.error(`  command: ${reqArgs.command}`);
      if (reqArgs.path !== undefined) console.error(`  path: ${reqArgs.path}`);
      console.error(`  cwd: ${req.cwd}`);
      console.error(`  reasons: ${req.reasons.join("; ")}`);
      console.error(
        `approve once? y/yes/approve · n/no/deny or empty line denies · any other input is queued as a task update · ctrl+d cancels`,
      );
      pendingApproval = { resolve, reject };
    });

  const harness = createHarness({
    systemOne,
    streamFn: models.streamSimple.bind(models),
    model,
    miniModel: miniModel ?? undefined,
    trust: args.trust,
    journalPath,
    cwd: args.cwd,
    skillRoots: args.skillRoots.map(expandHome),
    focusMode: args.focusMode,
    approvalHandler: args.task ? undefined : approvalHandler,
    onReflex: (line) => console.error(renderReflex(line)),
    onDelta: (delta) => process.stdout.write(delta),
  });

  function deliverQueuedUpdate(text: string): void {
    if (harness.recorder.currentTask) harness.recorder.updateTask(text);
    else harness.recorder.startTask(text);
    harness.agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  }

  function resolvePendingApproval(input: string): void {
    const pending = pendingApproval;
    if (!pending) return;
    if (/^(?:y|yes|approve)$/i.test(input)) {
      pendingApproval = undefined;
      pending.resolve("approve_once");
    } else if (input.length === 0 || /^(?:n|no|deny)$/i.test(input)) {
      pendingApproval = undefined;
      pending.resolve("deny");
    } else {
      console.log("queued until current action resolves");
      steerQueue.push(input);
      return;
    }
    for (const queued of steerQueue.splice(0)) deliverQueuedUpdate(queued);
  }

  async function pumpPrompts(): Promise<void> {
    while (promptQueue.length > 0) {
      const text = promptQueue.shift()!;
      process.stdout.write("\n");
      try {
        await harness.prompt(text);
      } catch (err) {
        harness.endSession("error", err instanceof Error ? err.message : String(err));
        console.error(err);
        process.exit(1);
      }
      process.stdout.write("\n");
    }
  }

  try {
    if (args.task) {
      await harness.prompt(args.task);
      process.stdout.write("\n");
      if (harness.approvalsRequested() > 0) {
        harness.endSession("normal");
        console.error("approval required");
        process.exit(3);
      }
      return;
    }

    console.log("type a task, ctrl+d to exit");
    const rl = createInterface({ input: process.stdin });
    let stdinClosed = false;
    let running = false;

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (pendingApproval) {
        resolvePendingApproval(trimmed);
        return;
      }
      if (running) {
        if (trimmed.length > 0) {
          console.log("queued until current action resolves");
          promptQueue.push(trimmed);
        }
        return;
      }
      if (trimmed.length > 0) promptQueue.push(trimmed);
      running = true;
      void pumpPrompts().then(() => {
        running = false;
      });
    });

    rl.on("close", () => {
      stdinClosed = true;
      const pending = pendingApproval;
      if (pending) {
        pendingApproval = undefined;
        pending.reject(new Error("stdin closed while approval pending"));
      }
    });

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (stdinClosed && !running && promptQueue.length === 0) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    harness.endSession("normal");
  } catch (err) {
    harness.endSession("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
