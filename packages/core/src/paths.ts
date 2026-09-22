import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

// The one resolver used by both policy checks (floor.ts) and execution
// (packages/cli's tools.ts/paths.ts): every caller that decides "is this
// path inside the project root" or "what is the canonical write target"
// funnels through these functions so policy and execution can never
// disagree about what a path resolves to.

export function expandHome(target: string): string {
  return target.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
}

export function normalizeAbsolute(abs: string): string {
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function toAbsolute(root: string, expanded: string): string {
  return isAbsolute(expanded) ? expanded : join(root, expanded);
}

export function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolvePath(root: string, target: string): string {
  // Canonicalize the root first so the lexical fallback below (used when the
  // full target doesn't exist yet) is built against the same root form
  // isInside() compares against — otherwise a root that is itself a symlink
  // (e.g. macOS's /var -> /private/var, common under os.tmpdir()) makes a
  // not-yet-existing target compare against a differently-spelled root and
  // wrongly resolve as "outside".
  const canonicalRoot = realpathIfExists(root);
  const lexicallyResolved = normalizeAbsolute(toAbsolute(canonicalRoot, expandHome(target)));
  // Non-existent symlink parents are resolved lexically; only existing paths are realpathed.
  return realpathIfExists(lexicallyResolved);
}

export function isInside(root: string, resolved: string): boolean {
  const rel = relative(realpathIfExists(root), resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Canonicalizes `target`'s existing ancestor chain via realpath while
 * leaving the final path component exactly as requested — deliberately NOT
 * dereferencing a final symlink, so a caller can identify (and reject) it as
 * the symlink's own location rather than silently following it to whatever
 * it points at.
 */
export function resolveParentForWrite(root: string, target: string): string {
  const resolved = normalizeAbsolute(toAbsolute(root, expandHome(target)));
  let probe = dirname(resolved);
  for (;;) {
    try {
      const real = realpathSync(probe);
      const rest = relative(probe, resolved);
      return rest === "" ? real : join(real, rest);
    } catch {
      const base = dirname(probe);
      if (base === probe) return resolved;
      probe = base;
    }
  }
}
