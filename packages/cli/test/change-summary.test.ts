import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeSummaryForWrite } from "../src/change-summary";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function tmp(): string {
  dir = mkdtempSync(join(tmpdir(), "brainstem-change-"));
  return dir;
}

describe("changeSummaryForWrite", () => {
  test("a short new file reports byte and line counts with its whole body", () => {
    const root = tmp();
    const summary = changeSummaryForWrite(root, "src/new.ts", "const a = 1;\nconst b = 2;\n");
    expect(summary.changeSummary).toContain("new file src/new.ts");
    expect(summary.changeSummary).toContain("26 bytes");
    expect(summary.changeSummary).toContain("const b = 2;");
    expect(summary.evidenceIncomplete).toBe(false);
  });

  test("a long new file sends the first 40 lines and marks the evidence incomplete", () => {
    const root = tmp();
    const body = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
    const summary = changeSummaryForWrite(root, "big.txt", body);
    expect(summary.changeSummary).toContain("first 40 lines");
    expect(summary.changeSummary).toContain("line 40");
    expect(summary.changeSummary).not.toContain("line 41");
    expect(summary.evidenceIncomplete).toBe(true);
  });

  test("an edit to an existing file sends a unified diff of just the changed lines", () => {
    const root = tmp();
    writeFileSync(join(root, "app.ts"), "a\nb\nc\n");
    const summary = changeSummaryForWrite(root, "app.ts", "a\nB\nc\n");
    expect(summary.changeSummary).toContain("overwrite existing app.ts");
    expect(summary.changeSummary).toContain("-b");
    expect(summary.changeSummary).toContain("+B");
    expect(summary.changeSummary).toContain(" a");
    expect(summary.evidenceIncomplete).toBe(false);
  });

  test("a diff past the cap is truncated and marked incomplete", () => {
    const root = tmp();
    writeFileSync(join(root, "app.ts"), Array.from({ length: 200 }, (_, i) => `old ${i}`).join("\n"));
    const summary = changeSummaryForWrite(root, "app.ts", Array.from({ length: 200 }, (_, i) => `new ${i}`).join("\n"));
    expect(summary.evidenceIncomplete).toBe(true);
    expect(summary.changeSummary).toContain("truncated at 1500 chars");
    expect(summary.changeSummary.length).toBeLessThan(1_800);
  });

  test("files too large to diff report line and byte counts rather than spending the latency budget", () => {
    const root = tmp();
    const before = Array.from({ length: 1_200 }, (_, i) => `x${i}`).join("\n");
    writeFileSync(join(root, "huge.txt"), before);
    const summary = changeSummaryForWrite(root, "huge.txt", `${before}\nextra`);
    expect(summary.changeSummary).toContain("too large to diff");
    expect(summary.changeSummary).toContain("1200 lines");
    expect(summary.evidenceIncomplete).toBe(true);
  });

  test("an identical overwrite is reported as a no-op change", () => {
    const root = tmp();
    writeFileSync(join(root, "same.txt"), "hello\n");
    const summary = changeSummaryForWrite(root, "same.txt", "hello\n");
    expect(summary.changeSummary).toContain("identical content");
    expect(summary.evidenceIncomplete).toBe(false);
  });

  test("the summary never carries the whole body of a large existing file", () => {
    const root = tmp();
    const body = Array.from({ length: 300 }, (_, i) => `secret-line-${i}`).join("\n");
    writeFileSync(join(root, "f.txt"), body);
    const summary = changeSummaryForWrite(root, "f.txt", `${body}\nappended`);
    expect(summary.changeSummary.length).toBeLessThan(body.length);
  });
});
