import { basename, dirname, join } from "node:path";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isInside, resolveParentForWrite, resolvePath } from "@brainstem/core";

// The canonical path resolvers live in @brainstem/core/paths.ts so that
// packages/core/src/floor.ts (policy) and this module (execution) share one
// resolver — see R2 in docs/plans/2026-09-22-review-remediation.md. This
// module re-exports them and adds the write-side verification/execution
// helpers that only make sense where files are actually written.
export { isInside, resolveParentForWrite, resolvePath };

export type WriteCapability = "atomic-verified";

/**
 * What this platform actually provides for write safety. "atomic-verified"
 * means: the final path component is rejected outright if it is a symlink
 * (existing or dangling), existing ancestors are canonicalized via realpath,
 * and the write itself lands via a same-directory temp file + rename (which
 * never follows a destination symlink and never truncates a shared-inode
 * target in place).
 *
 * This is NOT full descriptor-relative (openat-style) traversal: Bun/Node
 * expose no public API to open a path relative to a held directory
 * descriptor, so a symlink substituted into an *intermediate* ancestor
 * between the checks below and the final rename is a real, undocumented-away
 * TOCTOU window this implementation does not close. Closing it fully would
 * require a native addon or an external sandboxing executor (see the plan's
 * escape hatch) — deliberately not built here. Do not report R2's race
 * guarantee as complete; only the final-symlink and hardlink-corruption
 * classes are structurally (not probabilistically) fixed.
 */
export function writeCapability(): WriteCapability {
  return "atomic-verified";
}

export interface WriteTargetCheck {
  ok: boolean;
  resolvedTarget: string;
  reason?: string;
  /** Permission bits of the file currently at resolvedTarget, when one exists — read via the SAME lstat used to reject a symlink, so it's never a second, separately racy stat. Absent when nothing exists there yet. */
  existingMode?: number;
}

/**
 * Resolves the canonical write target and rejects any request whose final
 * path component is a symlink — existing (pointing inside or outside the
 * root) or dangling — or any existing non-regular-file occupant. Rejection,
 * not silent substitution, is the contract: the caller decides which target
 * it meant, never the filesystem's current symlink state.
 */
export function checkWriteTarget(root: string, target: string): WriteTargetCheck {
  const resolvedTarget = resolveParentForWrite(root, target);
  let st;
  try {
    st = lstatSync(resolvedTarget);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink()) {
    return {
      ok: false,
      resolvedTarget,
      reason: `refusing to write through a symlink at "${target}": the final path component is a symlink, not a regular file`,
    };
  }
  if (st && !st.isFile()) {
    return {
      ok: false,
      resolvedTarget,
      reason: `refusing to write "${target}": an existing non-regular file occupies that path`,
    };
  }
  return { ok: true, resolvedTarget, ...(st ? { existingMode: st.mode & 0o777 } : {}) };
}

export type WriteResult = { ok: true; resolvedTarget: string; bytesWritten: number } | { ok: false; reason: string };

/**
 * Writes `content` to `target` under `root` using the verified path and an
 * atomic same-directory temp-file-then-rename. `rename()` never dereferences
 * its destination, so even a symlink introduced at the exact final path in
 * the race window between the check below and this call is not followed —
 * worst case the rename replaces the symlink's own directory entry, which
 * still cannot write outside the intended directory.
 *
 * An existing file's permission bits are preserved on the replacement: the
 * temp file is created with the process's default mode (subject to umask),
 * then explicitly chmod'd to the prior file's mode — read from the SAME
 * lstat that already rejected a symlink there, never a fresh path-based
 * stat — before the rename makes it visible at the real path. This does not
 * reopen the hardlink/symlink hazards atomic replacement exists to close:
 * the chmod targets the freshly-created temp file by its own path (never
 * the original target), so it can't be tricked into changing an unrelated
 * file's permissions.
 */
export function writeFileVerified(root: string, target: string, content: string): WriteResult {
  const check = checkWriteTarget(root, target);
  if (!check.ok) return { ok: false, reason: check.reason! };

  const dir = dirname(check.resolvedTarget);
  mkdirSync(dir, { recursive: true });

  // Re-check after mkdir: creating missing ancestors re-resolves the path by
  // string, so re-verify the final target is still not a symlink immediately
  // before writing. This narrows, but — see writeCapability's doc comment —
  // does not eliminate, the TOCTOU window for a concurrently substituted
  // ancestor directory.
  const recheck = checkWriteTarget(root, target);
  if (!recheck.ok) return { ok: false, reason: recheck.reason! };

  const base = basename(recheck.resolvedTarget);
  const tmp = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
  try {
    if (recheck.existingMode !== undefined) {
      chmodSync(tmp, recheck.existingMode);
    }
    renameSync(tmp, recheck.resolvedTarget);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
  return { ok: true, resolvedTarget: recheck.resolvedTarget, bytesWritten: Buffer.byteLength(content, "utf8") };
}
