import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTools } from "../src/tools";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

interface BashResult {
  content: { type: string; text: string }[];
  details: { exit: number; status: string; durationMs: number; truncated: boolean };
}

function bashTool(cwd: string, opts: { killGraceMs?: number; drainGraceMs?: number } = {}) {
  const tool = makeTools({ cwd, ...opts }).find((t) => t.name === "bash")!;
  return {
    run(command: string, signal?: AbortSignal) {
      return tool.execute("t1", { command }, signal) as Promise<BashResult>;
    },
    runWithTimeout(command: string, timeout_ms: number) {
      return tool.execute("t2", { command, timeout_ms }) as Promise<BashResult>;
    },
  };
}

describe("bash tool", () => {
  test("captures output spanning multiple stdout chunks", async () => {
    const { run } = bashTool(process.cwd());
    const result = await run("echo A; echo B");
    expect(result.details.status).toBe("ok");
    expect(result.details.exit).toBe(0);
    expect(result.content[0]?.text).toContain("A");
    expect(result.content[0]?.text).toContain("B");
  });

  test("drains output beyond the per-stream retention limit without blocking and reports truncated", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-"));
    const { run } = bashTool(dir);
    const result = await run("head -c 300000 /dev/zero | tr '\\0' 'x'; echo done-large");
    expect(result.details.status).toBe("ok");
    expect(result.details.truncated).toBe(true);
    // R5: the tool's own capture limit is the per-stream retention cap
    // (256,000 bytes), not a smaller display-oriented cap — a separate,
    // downstream presentation boundary (packages/cli/src/output/present.ts)
    // is responsible for what's actually shown to the model.
    expect(result.content[0]?.text.length).toBeLessThanOrEqual(256_000 + 1_000);
    expect(result.content[0]?.text.length).toBeGreaterThan(51_000);
  });

  test("R5: retained stdout is not clipped by any smaller display-oriented cap, and byte accounting is exact", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-"));
    const { run } = bashTool(dir);
    const result = await run("head -c 60000 /dev/zero | tr '\\0' 'a'");
    expect(result.details.status).toBe("ok");
    expect(result.details.truncated).toBeFalsy();
    expect((result as unknown as { details: { stdoutText: string } }).details.stdoutText.length).toBe(60_000);
    expect((result as unknown as { details: { stdoutBytes: number } }).details.stdoutBytes).toBe(60_000);
  });

  test("R5: leading/trailing whitespace in captured output is preserved, not trimmed", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-"));
    const { run } = bashTool(dir);
    const result = await run("printf '  leading and trailing  \\n\\n'");
    const stdoutText = (result as unknown as { details: { stdoutText: string } }).details.stdoutText;
    expect(stdoutText.startsWith("  leading")).toBe(true);
    expect(stdoutText.endsWith("\n\n")).toBe(true);
  });

  test("R5: stderr-only failures are captured as their own stream, separate from stdout", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-"));
    const { run } = bashTool(dir);
    const result = await run("echo only-stderr >&2; exit 1");
    const details = result.details as unknown as { stdoutText: string; stderrText: string };
    expect(details.stdoutText).toBe("");
    expect(details.stderrText).toContain("only-stderr");
  });

  test("small output is not truncated", async () => {
    const { run } = bashTool(process.cwd());
    const result = await run("echo small");
    expect(result.details.truncated).toBe(false);
    expect(result.details.status).toBe("ok");
  });

  test("nonzero exit is a structured error, not a throw, and includes stderr", async () => {
    const { run } = bashTool(process.cwd());
    const result = await run("echo boom-stderr >&2; exit 3");
    expect(result.details.status).toBe("error");
    expect(result.details.exit).toBe(3);
    expect(result.content[0]?.text).toContain("boom-stderr");
  });

  test("timeout is distinguishable from error and cancel", async () => {
    const { runWithTimeout } = bashTool(process.cwd());
    const result = await runWithTimeout("sleep 5", 100);
    expect(result.details.status).toBe("timeout");
    expect(result.details.durationMs).toBeLessThan(5000);
    expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("caller cancel is distinguishable from timeout", async () => {
    const { run } = bashTool(process.cwd());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await run("sleep 5", controller.signal);
    expect(result.details.status).toBe("cancelled");
  });

  test("cancellation before spawn never spawns a process", async () => {
    const { run } = bashTool(process.cwd());
    const controller = new AbortController();
    controller.abort();
    const result = await run("echo should-not-run", controller.signal);
    expect(result.details.status).toBe("cancelled");
    expect(result.details.durationMs).toBe(0);
  });
});

describe("R4: managed process group termination", () => {
  test("a grandchild that ignores SIGTERM is force-killed with the group, within deadline + grace + drain", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-r4-"));
    const marker = join(dir, "grandchild-survived");
    // A detached-in-shell grandchild traps SIGTERM (ignores it) and would
    // touch the marker file after 400ms if it survived — well past the
    // kill+grace+drain bound below (50 + 50 + 20 = 120ms), so the marker
    // must never appear if the whole process group was actually terminated.
    const { runWithTimeout } = bashTool(dir, { killGraceMs: 50, drainGraceMs: 20 });
    const command = `(trap '' TERM; sleep 0.4; touch "${marker}") & disown; sleep 5`;

    const started = performance.now();
    const result = await runWithTimeout(command, 50);
    const elapsedMs = performance.now() - started;

    expect(result.details.status).toBe("timeout");
    // Settles near the timeout+grace+drain bound, not anywhere near the full
    // 5s sleep the outer shell was asked to run.
    expect(elapsedMs).toBeLessThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(existsSync(marker)).toBe(false);
  });

  test("a direct child ignoring SIGTERM is still forced to exit by SIGKILL within grace", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-r4-"));
    const { runWithTimeout } = bashTool(dir, { killGraceMs: 50, drainGraceMs: 20 });
    const started = performance.now();
    const result = await runWithTimeout("trap '' TERM; sleep 5", 50);
    const elapsedMs = performance.now() - started;
    expect(result.details.status).toBe("timeout");
    // 50ms timeout + 50ms grace + 20ms drain + scheduling slack, nowhere
    // near the untrapped 5s sleep.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test("successful execution well under the timeout completes near actual duration with no leaked timers", async () => {
    const { run } = bashTool(process.cwd(), { killGraceMs: 50, drainGraceMs: 20 });
    const started = performance.now();
    const result = await run("echo quick");
    const elapsedMs = performance.now() - started;
    expect(result.details.status).toBe("ok");
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("R4 regression: a backgrounded descendant with redirected stdio that outlives the direct shell is still killed (readiness-synchronized)", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-r4-"));
    const bash = makeTools({ cwd: dir, killGraceMs: 50, drainGraceMs: 20 }).find((t) => t.name === "bash")!;
    const controller = new AbortController();
    let readyAt = 0;
    // Poll for a readiness marker instead of a fixed sleep, then cancel —
    // this is the exact defect the review reproduced: the direct shell
    // (with redirected-away stdio, ignoring nothing) exits almost instantly
    // once signalled, while the trapped, redirected background job it spawned
    // was previously left alive because the scheduled SIGKILL got silently
    // skipped/cancelled as soon as our own pipes closed.
    const watch = setInterval(() => {
      if (existsSync(join(dir, "ready"))) {
        readyAt = performance.now();
        clearInterval(watch);
        controller.abort();
      }
    }, 5);
    const safetyTimer = setTimeout(() => controller.abort(), 3000);
    const command = "(trap '' TERM; printf yes > ready; sleep 0.5; printf yes > survived) >/dev/null 2>&1 & wait";
    const result: { details: { status: string } } = (await bash.execute(
      "cancel",
      { command, timeout_ms: 5000 },
      controller.signal,
    )) as never;
    clearInterval(watch);
    clearTimeout(safetyTimer);
    expect(readyAt).toBeGreaterThan(0);
    const settledAfterReadyMs = performance.now() - readyAt;
    expect(result.details.status).toBe("cancelled");
    // Settles quickly after readiness — not anywhere near the backgrounded
    // job's 500ms sleep before it would have written "survived".
    expect(settledAfterReadyMs).toBeLessThan(400);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(existsSync(join(dir, "survived"))).toBe(false);
  });

  test("R4 regression: a descendant that escapes the process group (detached) does not hang the tool call past the drain bound", async () => {
    let hasPython3 = true;
    try {
      execFileSync("python3", ["--version"], { stdio: "ignore" });
    } catch {
      hasPython3 = false;
    }
    if (!hasPython3) return; // environment without python3: nothing to detach with, skip rather than false-fail

    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-r4-"));
    writeFileSync(join(dir, "detach.py"), "import os,time\nos.setsid()\ntime.sleep(1.0)\n");
    const bash = makeTools({ cwd: dir, killGraceMs: 50, drainGraceMs: 20 }).find((t) => t.name === "bash")!;
    const started = performance.now();
    const result = (await bash.execute("drain", { command: "python3 detach.py & wait", timeout_ms: 200 })) as {
      details: { status: string };
    };
    const elapsedMs = performance.now() - started;
    expect(result.details.status).toBe("timeout");
    // The detached descendant is outside our process group (a documented,
    // accepted limitation — SIGKILL cannot reach it) and inherits our stdio
    // pipes without redirecting them, so nothing but the drain bound can end
    // this call. It must settle near timeout + grace + drain (200+50+20),
    // never anywhere near the detached process's own 1000ms sleep.
    expect(elapsedMs).toBeLessThan(600);
  });
});

describe("R2: write tool is itself a managed executor", () => {
  test("refuses to write through a symlink, even called directly (not just via the harness gate)", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-write-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "brainstem-tools-write-outside-"));
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "original");
    symlinkSync(outsideFile, join(dir, "link.txt"));

    const write = makeTools({ cwd: dir }).find((t) => t.name === "write")!;
    await expect(write.execute("t1", { path: "link.txt", content: "attacker content" })).rejects.toThrow(/symlink/);
    expect(readFileSync(outsideFile, "utf8")).toBe("original");

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("an ordinary write succeeds and reports the resolved target", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-write-"));
    const write = makeTools({ cwd: dir }).find((t) => t.name === "write")!;
    const result = (await write.execute("t1", { path: "sub/file.txt", content: "hello" })) as {
      content: { text: string }[];
      details: { path: string; bytes: number; resolvedTarget: string };
    };
    expect(result.details.bytes).toBe(5);
    expect(readFileSync(join(dir, "sub", "file.txt"), "utf8")).toBe("hello");
  });
});
