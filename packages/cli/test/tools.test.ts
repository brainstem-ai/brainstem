import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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

function bashTool(cwd: string) {
  const tool = makeTools({ cwd }).find((t) => t.name === "bash")!;
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

  test("drains output beyond the retention limit without blocking and reports truncated", async () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-tools-"));
    const { run } = bashTool(dir);
    const result = await run("head -c 300000 /dev/zero | tr '\\0' 'x'; echo done-large");
    expect(result.details.status).toBe("ok");
    expect(result.details.truncated).toBe(true);
    expect(result.content[0]?.text.length).toBeLessThanOrEqual(51_000);
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
});
