import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  choiceAnswer,
  mockSystemOne,
  noulAnswer,
  scoreAnswer,
  type Answer,
  type ApprovalRequest,
  type ApprovalResolution,
  type JournalEvent,
  type SystemOne,
} from "@brainstem/core";
import { createHarness, type Harness } from "../src/harness";

const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "mock-brain",
    usage: NO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function scriptedStream(script: AssistantMessage[]): StreamFn {
  let i = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = script[Math.min(i, script.length - 1)]!;
    i += 1;
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
    });
    return stream;
  };
}

// Gate always answers ask_user (safe on every other axis), so every bash call
// lands in the approval flow; sanitize/verify answers stay benign.
function askUserSystemOne(): SystemOne {
  return mockSystemOne((_state, questions): Record<string, Answer> => {
    if ("contains_agent_directive" in questions) {
      return {
        contains_agent_directive: noulAnswer(0.02),
        tries_to_override: noulAnswer(0.01),
        requests_dangerous_action: noulAnswer(0.01),
        severity: scoreAnswer(0, 0.9),
      };
    }
    return {
      destructive: scoreAnswer(0, 0.9),
      touches_credentials: noulAnswer(0.03),
      exfiltrates: noulAnswer(0.02),
      writes_outside_project: noulAnswer(0.02),
      on_task: noulAnswer(0.95),
      disposition: choiceAnswer("ask_user", 0.9, { ask_user: 0.9, auto_run: 0.05, deny: 0.05 }),
    };
  });
}

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function eventsOf(journalPath: string): JournalEvent[] {
  return readFileSync(journalPath, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JournalEvent);
}

function approvalEvents(events: JournalEvent[]) {
  return events.filter((e): e is Extract<JournalEvent, { t: "approval" }> => e.t === "approval");
}

function toolResultOf(harness: Harness, toolCallId: string): { isError: boolean; text: string } {
  const message = harness.agent.state.messages.find(
    (m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === toolCallId,
  ) as { isError: boolean; content: { type: string; text?: string }[] } | undefined;
  if (!message) throw new Error(`no toolResult for ${toolCallId}`);
  return { isError: message.isError, text: message.content.map((c) => c.text ?? "").join("\n") };
}

interface Setup {
  harness: Harness;
  executions: string[];
  requests: ApprovalRequest[];
}

async function setup(options: {
  script: AssistantMessage[];
  approvalHandler?: (req: ApprovalRequest) => Promise<ApprovalResolution>;
}): Promise<Setup> {
  dir = mkdtempSync(join(tmpdir(), "brainstem-approval-"));
  const journalPath = join(dir, "journal.ndjson");
  const executions: string[] = [];
  const requests: ApprovalRequest[] = [];

  const harness = createHarness({
    systemOne: askUserSystemOne(),
    streamFn: scriptedStream(options.script),
    model: undefined as never,
    trust: 0.3,
    journalPath,
    cwd: dir,
    ...(options.approvalHandler
      ? {
          approvalHandler: async (req: ApprovalRequest) => {
            requests.push(req);
            return options.approvalHandler!(req);
          },
        }
      : {}),
  });

  const bashTool = harness.agent.state.tools.find((t) => t.name === "bash")!;
  const original = bashTool.execute.bind(bashTool);
  bashTool.execute = async (id: string, params: unknown, signal?: AbortSignal) => {
    executions.push(id);
    return original(id as never, params as never, signal as never) as never;
  };

  return { harness, executions, requests };
}

const BASH_CALL = (id: string, command: string): AssistantMessage =>
  assistantMessage([{ type: "toolCall", id, name: "bash", arguments: { command } }], "toolUse");

const DONE = assistantMessage([{ type: "text", text: "done." }], "stop");

describe("approval lifecycle", () => {
  test("approve_once executes the exact tool once and journals requested+approved", async () => {
    const { harness, executions, requests } = await setup({
      script: [BASH_CALL("tc1", "echo approval-ok"), DONE],
      approvalHandler: async () => "approve_once",
    });

    await harness.prompt("run one command");

    expect(executions).toEqual(["tc1"]);
    expect(requests.length).toBe(1);
    const approvals = approvalEvents(eventsOf(harness.journalPath));
    expect(approvals.map((e) => e.status)).toEqual(["requested", "approved"]);
    expect(approvals[0]!.approvalId).toBe(approvals[1]!.approvalId);
    expect(approvals[0]!.toolCallId).toBe("tc1");
    expect(approvals[0]!.actionHash).toBe(approvals[1]!.actionHash);
    expect(toolResultOf(harness, "tc1").isError).toBe(false);
  });

  test("deny blocks the tool and journals requested+denied", async () => {
    const { harness, executions } = await setup({
      script: [BASH_CALL("tc1", "echo should-not-run"), DONE],
      approvalHandler: async () => "deny",
    });

    await harness.prompt("run one command");

    expect(executions).toEqual([]);
    const result = toolResultOf(harness, "tc1");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[brainstem] denied by user");
    const approvals = approvalEvents(eventsOf(harness.journalPath));
    expect(approvals.map((e) => e.status)).toEqual(["requested", "denied"]);
  });

  test("handler throw cancels the approval and blocks the tool", async () => {
    const { harness, executions } = await setup({
      script: [BASH_CALL("tc1", "echo cancelled-case"), DONE],
      approvalHandler: async () => {
        throw new Error("handler exploded");
      },
    });

    await harness.prompt("run one command");

    expect(executions).toEqual([]);
    const result = toolResultOf(harness, "tc1");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[brainstem] approval cancelled");
    const approvals = approvalEvents(eventsOf(harness.journalPath));
    expect(approvals.map((e) => e.status)).toEqual(["requested", "cancelled"]);
  });

  test("no handler (noninteractive) blocks and journals requested+invalidated", async () => {
    const { harness, executions } = await setup({
      script: [BASH_CALL("tc1", "echo no-handler"), DONE],
    });

    await harness.prompt("run one command");

    expect(executions).toEqual([]);
    const result = toolResultOf(harness, "tc1");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Ask the user to confirm");
    const approvals = approvalEvents(eventsOf(harness.journalPath));
    expect(approvals.map((e) => e.status)).toEqual(["requested", "invalidated"]);
    expect(approvals[1]!.reasons).toEqual(["no handler"]);
    expect(harness.approvalsRequested()).toBe(1);
  });

  test("static floor deny bypasses the approval flow entirely", async () => {
    let handlerCalls = 0;
    const { harness } = await setup({
      script: [BASH_CALL("tc1", "rm -rf /"), DONE],
      approvalHandler: async () => {
        handlerCalls += 1;
        return "approve_once";
      },
    });

    await harness.prompt("clean the disk");

    expect(handlerCalls).toBe(0);
    expect(approvalEvents(eventsOf(harness.journalPath))).toEqual([]);
    const result = toolResultOf(harness, "tc1");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("denied");
  });

  test("two sequential asks get distinct approvalIds and one approval cannot satisfy the other", async () => {
    const resolutions: ApprovalResolution[] = ["approve_once", "deny"];
    const { harness, executions, requests } = await setup({
      script: [
        assistantMessage(
          [
            { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "echo first" } },
            { type: "toolCall", id: "tc2", name: "bash", arguments: { command: "echo second" } },
          ],
          "toolUse",
        ),
        DONE,
      ],
      approvalHandler: async () => resolutions[requests.length - 1] ?? "deny",
    });

    await harness.prompt("run two commands");

    expect(requests.length).toBe(2);
    expect(requests[0]!.id).not.toBe(requests[1]!.id);
    expect(requests[0]!.toolCallId).toBe("tc1");
    expect(requests[1]!.toolCallId).toBe("tc2");
    expect(executions).toEqual(["tc1"]);

    const approvals = approvalEvents(eventsOf(harness.journalPath));
    const requestedIds = approvals.filter((e) => e.status === "requested").map((e) => e.approvalId);
    expect(new Set(requestedIds).size).toBe(2);
    expect(approvals.filter((e) => e.status === "approved").length).toBe(1);
    expect(approvals.filter((e) => e.status === "denied").length).toBe(1);
    expect(toolResultOf(harness, "tc2").isError).toBe(true);
  });

  test("steered task update during approval does not replace the task objective", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-approval-"));
    const journalPath = join(dir, "journal.ndjson");

    let harness: Harness | undefined;
    harness = createHarness({
      systemOne: askUserSystemOne(),
      streamFn: scriptedStream([BASH_CALL("tc1", "echo steered"), DONE]),
      model: undefined as never,
      trust: 0.3,
      journalPath,
      cwd: dir,
      approvalHandler: async () => {
        // Mirrors the CLI: a queued stdin line is recorded as a task update and
        // steered into the run after the approval resolves — never a new task.
        harness!.recorder.updateTask("stop after this command");
        harness!.agent.steer({
          role: "user",
          content: [{ type: "text", text: "stop after this command" }],
          timestamp: Date.now(),
        });
        return "approve_once";
      },
    });

    await harness.prompt("original objective");

    const events = eventsOf(journalPath);
    const taskStarts = events.filter((e): e is Extract<JournalEvent, { t: "task_start" }> => e.t === "task_start");
    expect(taskStarts.length).toBe(1);
    expect(taskStarts[0]!.objective).toBe("original objective");
    const updates = events.filter((e): e is Extract<JournalEvent, { t: "task_update" }> => e.t === "task_update");
    expect(updates.length).toBe(1);
    expect(updates[0]!.text).toBe("stop after this command");
    expect(approvalEvents(events).some((e) => e.status === "approved")).toBe(true);
  });
});

const WRITE_CALL = (id: string, path: string, content: string): AssistantMessage =>
  assistantMessage([{ type: "toolCall", id, name: "write", arguments: { path, content } }], "toolUse");

describe("R3: immutable, action-specific approvals for writes", () => {
  test("the approval request shows the actual proposed diff, not just command/path", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-approval-r3-"));
    writeFileSync(join(dir, "app.ts"), "const port = 3000;\n");
    const journalPath = join(dir, "journal.ndjson");
    let seenRequest: ApprovalRequest | undefined;

    const harness = createHarness({
      systemOne: askUserSystemOne(),
      streamFn: scriptedStream([WRITE_CALL("tc1", "app.ts", "const port = 8080;\n"), DONE]),
      model: undefined as never,
      trust: 0.3,
      journalPath,
      cwd: dir,
      approvalHandler: async (req) => {
        seenRequest = req;
        return "deny";
      },
    });

    await harness.prompt("bump the port");

    expect(seenRequest?.changeSummary).toContain("-const port = 3000;");
    expect(seenRequest?.changeSummary).toContain("+const port = 8080;");
    expect(seenRequest?.target).toContain("app.ts");
  });

  test("a file edited between approval request and resolution invalidates the approval instead of executing the stale write", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-approval-r3-"));
    const target = join(dir, "config.json");
    writeFileSync(target, '{"port":3000}');
    const journalPath = join(dir, "journal.ndjson");

    const harness = createHarness({
      systemOne: askUserSystemOne(),
      streamFn: scriptedStream([WRITE_CALL("tc1", "config.json", '{"port":8080}'), DONE]),
      model: undefined as never,
      trust: 0.3,
      journalPath,
      cwd: dir,
      approvalHandler: async () => {
        // Simulate a concurrent edit landing while the human is still looking
        // at the (now-stale) diff.
        writeFileSync(target, '{"port":9999,"editedConcurrently":true}');
        return "approve_once";
      },
    });

    await harness.prompt("bump the port");

    // The write must NOT have executed against the stale approved content.
    expect(readFileSync(target, "utf8")).toBe('{"port":9999,"editedConcurrently":true}');
    const approvals = approvalEvents(eventsOf(harness.journalPath));
    expect(approvals.map((e) => e.status)).toEqual(["requested", "invalidated"]);
    const result = toolResultOf(harness, "tc1");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("changed since approval was requested");
  });

  test("approving a write with one content payload never permits a different payload (distinct action hashes)", async () => {
    async function actionHashFor(content: string): Promise<string> {
      dir = mkdtempSync(join(tmpdir(), "brainstem-approval-r3-"));
      const journalPath = join(dir, "journal.ndjson");
      const harness = createHarness({
        systemOne: askUserSystemOne(),
        streamFn: scriptedStream([WRITE_CALL("tc1", "new-file.txt", content), DONE]),
        model: undefined as never,
        trust: 0.3,
        journalPath,
        cwd: dir,
        approvalHandler: async () => "deny",
      });
      await harness.prompt("write a file");
      const approvals = approvalEvents(eventsOf(harness.journalPath));
      const hash = approvals[0]!.actionHash;
      rmSync(dir, { recursive: true, force: true });
      dir = "";
      return hash;
    }

    const hashA = await actionHashFor("content A");
    const hashB = await actionHashFor("content B");
    expect(hashA).not.toBe(hashB);
  });
});
