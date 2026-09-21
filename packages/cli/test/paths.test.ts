import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside, resolveParentForWrite, resolvePath } from "../src/paths";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("resolvePath", () => {
  test("joins relative targets to root and normalizes . and .. segments", () => {
    expect(resolvePath("/repo", "src/./auth.ts")).toBe("/repo/src/auth.ts");
    expect(resolvePath("/repo", "src/sub/../auth.ts")).toBe("/repo/src/auth.ts");
    expect(resolvePath("/repo", "../escape.txt")).toBe("/escape.txt");
  });

  test("absolute targets bypass root", () => {
    expect(resolvePath("/repo", "/tmp/scratch.txt")).toBe("/tmp/scratch.txt");
    expect(resolvePath("/repo", "/repo/src/auth.ts")).toBe("/repo/src/auth.ts");
  });

  test("~ resolves against HOME", () => {
    const home = process.env.HOME ?? "/";
    expect(resolvePath("/repo", "~/notes.txt")).toBe(join(home, "notes.txt"));
    expect(resolvePath("/repo", "~")).toBe(home);
  });
});

describe("isInside", () => {
  test("handles the sibling-prefix trap", () => {
    expect(isInside("/root", "/root/file.txt")).toBe(true);
    expect(isInside("/root", "/root/sub/file.txt")).toBe(true);
    expect(isInside("/root", "/root")).toBe(true);
    expect(isInside("/root", "/root2/file.txt")).toBe(false);
    expect(isInside("/root", "/root/../root2/file.txt")).toBe(false);
    expect(isInside("/root", "/escape.txt")).toBe(false);
  });
});

describe("resolveParentForWrite", () => {
  test("resolves a not-yet-existing parent chain inside the root", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-"));
    const result = resolveParentForWrite(dir, "new/deep/file.txt");
    expect(result.endsWith(join("new", "deep", "file.txt"))).toBe(true);
    expect(isInside(dir, result)).toBe(true);
  });

  test("existing parents are realpathed so symlinked roots stay contained", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-"));
    const result = resolveParentForWrite(dir, "file.txt");
    expect(result).toBe(join(realpathSync(dir), "file.txt"));
  });

  test("absolute escapes stay outside the root", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-"));
    const result = resolveParentForWrite(dir, "/tmp/brainstem-escape/file.txt");
    expect(isInside(dir, result)).toBe(false);
  });
});
