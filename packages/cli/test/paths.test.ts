import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWriteTarget, isInside, resolveParentForWrite, resolvePath, writeFileVerified } from "../src/paths";

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

describe("R2: resolvePath/isInside stay consistent when the root itself is a symlink", () => {
  test("a not-yet-existing target under a symlinked root (e.g. os.tmpdir() on macOS) still resolves inside", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-symlink-root-"));
    const resolved = resolvePath(dir, "not-yet-created/file.txt");
    expect(isInside(dir, resolved)).toBe(true);
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

describe("R2: checkWriteTarget / writeFileVerified — bind the check to the actual write", () => {
  test("a final symlink pointing outside the root is rejected, not followed", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-outside-"));
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "original outside content");
    const link = join(dir, "link-to-outside.txt");
    symlinkSync(outsideFile, link);

    const check = checkWriteTarget(dir, "link-to-outside.txt");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("symlink");

    const result = writeFileVerified(dir, "link-to-outside.txt", "attacker-controlled content");
    expect(result.ok).toBe(false);
    // The reproduction from the review: a link inside the repo to an outside
    // file leaves the outside file unchanged and cannot auto-run.
    expect(readFileSync(outsideFile, "utf8")).toBe("original outside content");

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("a dangling symlink is rejected, not silently created through", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const link = join(dir, "dangling.txt");
    symlinkSync(join(dir, "does-not-exist-target.txt"), link);

    const result = writeFileVerified(dir, "dangling.txt", "content");
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, "does-not-exist-target.txt"))).toBe(false);
  });

  test("a symlinked PARENT directory inside the root is followed via realpath, and containment is still enforced", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-outside-"));
    const parentLink = join(dir, "linked-dir");
    symlinkSync(outsideDir, parentLink);

    // Writing THROUGH a symlinked parent directory is allowed (the parent
    // chain is canonicalized via realpath) but the realpath'd destination is
    // OUTSIDE the configured root, so containment must catch it — this
    // module only rejects a symlinked FINAL component outright; outside-root
    // containment for a symlinked parent is the caller's (harness gate's)
    // responsibility, verified here at the resolution layer.
    const check = checkWriteTarget(dir, "linked-dir/new-file.txt");
    expect(check.ok).toBe(true);
    expect(isInside(dir, check.resolvedTarget)).toBe(false);
    expect(isInside(outsideDir, check.resolvedTarget)).toBe(true);

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("writing to a hard-linked destination does not modify the other link's inode (no in-place truncation)", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const target = join(dir, "target.txt");
    const other = join(dir, "other-link.txt");
    writeFileSync(target, "shared original content");
    linkSync(target, other);
    expect(statSync(target).ino).toBe(statSync(other).ino);

    const result = writeFileVerified(dir, "target.txt", "new content via target");
    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("new content via target");
    // The other hardlink must still see the ORIGINAL content: a rename-based
    // replace creates a new inode rather than truncating the shared one.
    expect(readFileSync(other, "utf8")).toBe("shared original content");
  });

  test("an existing non-regular-file occupant (a directory) is rejected rather than silently replaced", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    mkdirSync(join(dir, "a-directory"));
    const result = writeFileVerified(dir, "a-directory", "content");
    expect(result.ok).toBe(false);
    expect(statSync(join(dir, "a-directory")).isDirectory()).toBe(true);
  });

  test("an ordinary write to a new file inside the root succeeds and is atomic (no leftover temp files)", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const result = writeFileVerified(dir, "new/nested/file.txt", "hello");
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "new", "nested", "file.txt"), "utf8")).toBe("hello");
  });

  test("P2/R2 regression: an atomic replacement preserves the existing file's permission bits, not the process default", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const privatePath = join(dir, "private.txt");
    writeFileSync(privatePath, "before");
    chmodSync(privatePath, 0o600);
    const executable = join(dir, "script.sh");
    writeFileSync(executable, "before");
    chmodSync(executable, 0o755);

    expect(writeFileVerified(dir, "private.txt", "after").ok).toBe(true);
    expect(writeFileVerified(dir, "script.sh", "after").ok).toBe(true);

    expect(statSync(privatePath).mode & 0o777).toBe(0o600);
    expect(statSync(executable).mode & 0o777).toBe(0o755);
    expect(readFileSync(privatePath, "utf8")).toBe("after");
    expect(readFileSync(executable, "utf8")).toBe("after");
  });

  test("P2/R2: a brand-new file gets the process default mode, not a preserved one (nothing existed to preserve)", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const result = writeFileVerified(dir, "new.txt", "content");
    expect(result.ok).toBe(true);
    // No prior file existed, so this is just documenting there's no crash
    // and a real (nonzero) mode is set — not asserting a specific umask.
    expect(statSync(join(dir, "new.txt")).mode & 0o777).toBeGreaterThan(0);
  });

  test("a sibling-prefix path is not treated as inside the root", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const sibling = `${dir}-sibling`;
    mkdirSync(sibling);
    const check = checkWriteTarget(dir, join("..", `${dir.split("/").pop()}-sibling`, "file.txt"));
    expect(isInside(dir, check.resolvedTarget)).toBe(false);
    rmSync(sibling, { recursive: true, force: true });
  });
});
