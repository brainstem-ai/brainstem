export type StaticVerdict = "deny" | "ask" | null;

export interface StaticAction {
  command?: string;
  path?: string;
}

const DENY_COMMANDS: RegExp[] = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+[/~]/,
  /\|\s*(ba|z|da)?sh\b/,
  /\/dev\/(sd|disk)/,
  /mkfs/,
  /:\(\)\s*\{.*\};:/,
  /chmod\s+-R\s+777\s+\//,
  /(\/etc\/|\/var\/|\/usr\/)/,
  /(~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.aws\/config)/,
  /DROP\s+(TABLE|DATABASE)/i,
  /(-d\s+@\.env|--data-binary\s+@-.*curl|curl.*\s-d\s*@\.env)/,
  /printenv.*\bcurl\b|\bcurl\b.*printenv/,
  /(hard\s+reset|diskutil\s+erase)/,
];

const ASK_COMMANDS: RegExp[] = [
  /git\s+push\s+.*--force\b|--force\b.*git\s+push/,
  /\bnpm\s+publish\b/,
  /docker\s+system\s+prune/,
];

const DENY_WRITE_PATHS: RegExp[] = [
  /^~\/\.ssh\//,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.aws\//,
  /id_rsa|id_ed25519|authorized_keys|\.ssh\//,
];

const DENY_WRITE_OUTSIDE_ROOT: RegExp[] = [
  /^(\/etc|\/var|\/usr|\/System|\/Library)\//,
];

const ASK_READ_PATHS: RegExp[] = [
  /(^|\/)\.env(\.|$)/,
  /(~|\/)\.aws\//,
  /\.ssh\//,
  /id_rsa|id_ed25519/,
];

const HOME = process.env.HOME ?? "";

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, HOME || "~");
}

function resolveUnderRoot(root: string, target: string): string {
  const expanded = expandHome(target);
  const abs = expanded.startsWith("/") ? expanded : `${root.replace(/\/+$/, "")}/${expanded}`;
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function isInside(root: string, resolved: string): boolean {
  const base = root.replace(/\/+$/, "") || "/";
  if (resolved === base) return true;
  return resolved.startsWith(base.endsWith("/") ? base : `${base}/`);
}

export function staticVerdict(tool: string, action: StaticAction, root: string): StaticVerdict {
  // Command-pattern checks are NOT an OS sandbox — they are a heuristic first line of defense.
  if (tool === "bash" && action.command) {
    const cmd = action.command;
    if (DENY_COMMANDS.some((re) => re.test(cmd))) return "deny";
    if (ASK_COMMANDS.some((re) => re.test(cmd))) return "ask";
    return null;
  }

  if (action.path) {
    const path = resolveUnderRoot(root, action.path);
    const inside = isInside(root, path);

    if (tool === "write") {
      if (DENY_WRITE_PATHS.some((re) => re.test(path))) return "deny";
      if (!inside) {
        if (DENY_WRITE_OUTSIDE_ROOT.some((re) => re.test(path))) return "deny";
        return "ask";
      }
      return null;
    }

    if (tool === "read" || tool === "grep" || tool === "glob") {
      if (ASK_READ_PATHS.some((re) => re.test(path))) return "ask";
      return null;
    }
  }

  return null;
}
