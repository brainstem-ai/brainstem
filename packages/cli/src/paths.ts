import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { contentHash, expandHome, isInside, normalizeAbsolute, realpathIfExists, resolveParentForWrite, resolvePath } from "@brainstem/core";

// The canonical path resolvers live in @brainstem/core/paths.ts so that
// packages/core/src/floor.ts (policy) and this module (execution) share one
// resolver — see R2 in docs/plans/2026-09-22-review-remediation.md. This
// module re-exports them and adds the write-side verification/execution
// helpers that only make sense where files are actually written.
export { isInside, resolveParentForWrite, resolvePath };

const NATIVE_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "native", "verified-write.py");
const DEFAULT_PYTHON_CANDIDATES = ["python3", "python"];
const HELPER_TIMEOUT_MS = 10_000;

export type WriteCapability = "descriptor-relative" | "unavailable";

/** Sentinel meaning "no file is expected to exist yet" — matches packages/cli/src/change-summary.ts's ABSENT_DIGEST. */
export const ABSENT_PREIMAGE_DIGEST = "absent";

export interface WriteExecutorOptions {
  /**
   * Test-only override: forces which interpreter name(s) to probe/use for
   * the descriptor-relative executor, so the "unavailable" fallback can be
   * exercised deterministically via a genuinely failing probe — not a
   * mocked boolean. Production code never sets this.
   */
  pythonBinCandidates?: string[];
  /**
   * sha256 hex digest the file's CURRENT content is expected to match
   * (ABSENT_PREIMAGE_DIGEST if no file is expected yet), checked inside the
   * SAME verified fd chain immediately before the write — not a separate,
   * earlier, re-racable step. Binds the action to its preimage through
   * execution, not just its target: a concurrent edit is rejected exactly
   * like a concurrent symlink swap. Omit to skip the check.
   */
  expectedPreimageDigest?: string;
}

let cachedCapability: WriteCapability | undefined;
let cachedPythonBin: string | undefined;

function detectPythonBin(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, [NATIVE_HELPER_PATH, "--probe"], { stdio: "ignore", timeout: HELPER_TIMEOUT_MS });
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Resolves which interpreter (if any) to use for the descriptor-relative
 * write executor. Cached across calls (availability doesn't change
 * mid-process) unless `options.pythonBinCandidates` is given, which always
 * runs a fresh, uncached probe — used only by tests exercising the
 * "unavailable" fallback against a real (deliberately failing) probe.
 */
function resolvePythonBin(options: WriteExecutorOptions): string | undefined {
  if (options.pythonBinCandidates) return detectPythonBin(options.pythonBinCandidates);
  if (cachedCapability !== undefined) return cachedCapability === "descriptor-relative" ? cachedPythonBin : undefined;
  if (process.platform === "win32") {
    cachedCapability = "unavailable";
    return undefined;
  }
  cachedPythonBin = detectPythonBin(DEFAULT_PYTHON_CANDIDATES);
  cachedCapability = cachedPythonBin !== undefined ? "descriptor-relative" : "unavailable";
  return cachedPythonBin;
}

/**
 * What this platform actually provides for write safety.
 *
 * "descriptor-relative" means a real isolated filesystem executor
 * (`packages/cli/src/native/verified-write.py`, invoked as a subprocess) is
 * available and is what actually performs every in-root write: it opens the
 * canonical root once, then walks each remaining path component relative to
 * the PREVIOUSLY VERIFIED parent directory's own file descriptor with
 * O_NOFOLLOW, so a symlink substituted into any ancestor — at any point
 * before or during that walk — cannot redirect the write, because the walk
 * never re-resolves a path string from scratch and never follows a symlink
 * it encounters. This is the real descriptor-relative/no-follow
 * traversal-and-commit the plan requires, not a second preflight check
 * layered on top of ordinary path-based I/O.
 *
 * "unavailable" means no such executor could be confirmed (no working
 * `python3`/`python` with the required `os.*(dir_fd=...)` support, or an
 * unsupported platform such as Windows). On "unavailable", in-root managed
 * writes are REFUSED outright — there is no silent fallback to a
 * check-then-write path pretending to be equivalently safe. The plan does
 * not contain an escape hatch that permits an unsafe managed write to stay
 * enabled; "unavailable" is that explicit, honest outcome, not a
 * completion of the race guarantee.
 *
 * A write whose target resolves OUTSIDE the configured root is a narrower,
 * separately-scoped case (see writeFileVerified's own doc comment) that
 * does not depend on this capability.
 */
export function writeCapability(options: WriteExecutorOptions = {}): WriteCapability {
  return resolvePythonBin(options) !== undefined ? "descriptor-relative" : "unavailable";
}

/** Test-only: clears the cached capability/interpreter so the next unparameterized call re-probes. */
export function _resetWriteCapabilityCacheForTests(): void {
  cachedCapability = undefined;
  cachedPythonBin = undefined;
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
 *
 * This function is GATE-TIME evidence and diagnostics (deciding ask/deny,
 * showing a diff, an early clear error message) — it is deliberately still
 * path-based and re-resolves on every call. It is NOT what makes the actual
 * write safe; that guarantee lives in writeFileVerified's descriptor-relative
 * executor for in-root writes. Do not treat a passing checkWriteTarget call
 * as proof that a subsequent write is safe from a concurrent substitution —
 * only the executor's own live traversal provides that.
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

function absoluteLexicalPath(root: string, target: string): string {
  const expanded = expandHome(target);
  return normalizeAbsolute(isAbsolute(expanded) ? expanded : join(root, expanded));
}

/**
 * Splits `absLexical` into path segments relative to `canonicalRoot`, or
 * returns null if it does not resolve under the root. Deliberately LEXICAL
 * (never realpath'd): a component list built from a realpath would already
 * have silently followed any symlink present at check time, which is
 * exactly the defect this function exists to avoid feeding into the
 * descriptor-relative executor — the executor's own live, no-follow walk is
 * what must discover a symlink, never a string resolver upstream of it.
 */
function componentsUnderRoot(canonicalRoot: string, absLexical: string): string[] | null {
  const prefix = canonicalRoot.endsWith("/") ? canonicalRoot : `${canonicalRoot}/`;
  if (absLexical === canonicalRoot) return [];
  if (!absLexical.startsWith(prefix)) return null;
  return absLexical
    .slice(prefix.length)
    .split("/")
    .filter((seg) => seg.length > 0);
}

function describeHelperFailure(status: number | null | undefined, stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.startsWith("SYMLINK_OR_NON_DIR:")) {
    return `refusing to write through a symlink or non-directory ancestor: ${trimmed.slice("SYMLINK_OR_NON_DIR:".length)}`;
  }
  if (trimmed.startsWith("FINAL_IS_SYMLINK:")) {
    return "refusing to write through a symlink: the final path component is a symlink, not a regular file";
  }
  if (trimmed.startsWith("FINAL_NOT_REGULAR:")) {
    return "refusing to write: an existing non-regular file occupies that path";
  }
  if (trimmed.startsWith("INVALID_COMPONENT:")) {
    return `refusing to write: invalid path component ${trimmed.slice("INVALID_COMPONENT:".length)}`;
  }
  if (trimmed.startsWith("ROOT_OPEN_FAILED:")) {
    return `refusing to write: the project root could not be opened (${trimmed.slice("ROOT_OPEN_FAILED:".length)})`;
  }
  if (trimmed.startsWith("PREIMAGE_MISMATCH:")) {
    return `file contents changed since approval was requested: ${trimmed.slice("PREIMAGE_MISMATCH:".length)}`;
  }
  return `managed write failed (exit ${status ?? "unknown"}): ${trimmed || "unknown error"}`;
}

function runDescriptorRelativeWrite(
  pythonBin: string,
  canonicalRoot: string,
  components: string[],
  content: string,
  expectedPreimageDigest: string,
): WriteResult {
  const finalName = components[components.length - 1]!;
  const intermediate = components.slice(0, -1);
  let stdout: string;
  try {
    stdout = execFileSync(pythonBin, [NATIVE_HELPER_PATH, canonicalRoot, expectedPreimageDigest, ...intermediate, finalName], {
      input: content,
      encoding: "utf8",
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // Fully capture stderr rather than the execFileSync default of also
      // inheriting it to our own stderr — a rejected write (e.g. a real
      // symlink attempt) is an expected, structured outcome here, not
      // something that should print raw subprocess diagnostics to the
      // terminal.
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number | null; stderr?: string | Buffer };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    return { ok: false, reason: describeHelperFailure(e.status, stderr) };
  }
  const match = stdout.trim().match(/^OK (\d+)$/);
  const bytesWritten = match ? Number(match[1]) : Buffer.byteLength(content, "utf8");
  return { ok: true, resolvedTarget: join(canonicalRoot, ...components), bytesWritten };
}

/**
 * Fallback for writes whose target resolves OUTSIDE the configured root.
 * Always requires explicit interactive human approval already (see
 * harness.ts) — unlike an in-root write, it is never auto-approved without
 * a person reviewing the actual target first — so the threat model this
 * narrows is bounded by how long that approval takes, not by an
 * unattended Jev decision. A single trusted anchor for a full
 * descriptor-relative walk does not exist for an arbitrary outside-root
 * location without either breaking on ordinary system symlinks (e.g.
 * macOS's /tmp -> /private/tmp, /var -> /private/var) or reintroducing the
 * exact gap the executor exists to close, so this path stays a
 * check-immediately-before-write + atomic same-directory rename. This is a
 * narrower, explicitly documented guarantee than the in-root path — see
 * README "Write safety".
 */
function writeFileCheckThenWrite(root: string, target: string, content: string, expectedPreimageDigest?: string): WriteResult {
  const check = checkWriteTarget(root, target);
  if (!check.ok) return { ok: false, reason: check.reason! };

  const dir = dirname(check.resolvedTarget);
  mkdirSync(dir, { recursive: true });

  const recheck = checkWriteTarget(root, target);
  if (!recheck.ok) return { ok: false, reason: recheck.reason! };

  if (expectedPreimageDigest !== undefined) {
    let currentDigest = ABSENT_PREIMAGE_DIGEST;
    try {
      currentDigest = contentHash(readFileSync(recheck.resolvedTarget, "utf8"));
    } catch {
      currentDigest = ABSENT_PREIMAGE_DIGEST;
    }
    if (currentDigest !== expectedPreimageDigest) {
      return {
        ok: false,
        reason: `file contents changed since approval was requested: expected ${expectedPreimageDigest} but found ${currentDigest}`,
      };
    }
  }

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

/**
 * Writes `content` to `target` under `root`.
 *
 * In-root targets (the common case, and the one that can be auto-approved
 * without a human ever reviewing it) go through the descriptor-relative
 * executor (see writeCapability's doc comment): every ancestor is opened
 * relative to the previously verified parent's own fd with O_NOFOLLOW, so a
 * symlink substituted into any ancestor at any point cannot redirect the
 * write. When that executor is unavailable on this platform, the write is
 * explicitly REFUSED — never silently downgraded to a path-based
 * check-then-write pretending to be equally safe.
 *
 * Outside-root targets use a narrower, separately documented fallback (see
 * writeFileCheckThenWrite).
 *
 * Preserves an existing file's permission bits on replacement in both
 * paths, and never truncates a hard-linked file's shared inode in place
 * (each path lands via a fresh file + atomic rename, not an in-place open).
 */
export function writeFileVerified(root: string, target: string, content: string, options: WriteExecutorOptions = {}): WriteResult {
  const canonicalRoot = realpathIfExists(root); // root is operator-configured and trusted; safe to realpath once, unlike a tool-argument-supplied target.
  const absLexical = absoluteLexicalPath(canonicalRoot, target);
  const components = componentsUnderRoot(canonicalRoot, absLexical);

  if (components !== null && components.length > 0) {
    const pythonBin = resolvePythonBin(options);
    if (pythonBin === undefined) {
      return {
        ok: false,
        reason:
          'managed write capability unavailable on this platform (no working descriptor-relative write executor found — see README "Write safety"): refusing to write rather than using an unverified check-then-write path',
      };
    }
    return runDescriptorRelativeWrite(pythonBin, canonicalRoot, components, content, options.expectedPreimageDigest ?? "-");
  }

  return writeFileCheckThenWrite(root, target, content, options.expectedPreimageDigest);
}
