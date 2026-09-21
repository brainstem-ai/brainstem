import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

function expandHome(target: string): string {
  return target.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
}

function normalizeAbsolute(abs: string): string {
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

function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolvePath(root: string, target: string): string {
  const lexicallyResolved = normalizeAbsolute(toAbsolute(root, expandHome(target)));
  // Non-existent symlink parents are resolved lexically; only existing paths are realpathed.
  return realpathIfExists(lexicallyResolved);
}

export function isInside(root: string, resolved: string): boolean {
  const rel = relative(realpathIfExists(root), resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

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
