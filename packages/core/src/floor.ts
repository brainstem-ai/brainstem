import { isInside, resolvePath } from "./paths";

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

const ASK_COMMANDS: RegExp[] = [/git\s+push\s+.*--force\b|--force\b.*git\s+push/, /\bnpm\s+publish\b/, /docker\s+system\s+prune/];

const DENY_WRITE_PATHS: RegExp[] = [/^~\/\.ssh\//, /(^|\/)\.env(\.|$)/, /(^|\/)\.aws\//, /id_rsa|id_ed25519|authorized_keys|\.ssh\//];

const DENY_WRITE_OUTSIDE_ROOT: RegExp[] = [
  // /etc, /var, and /tmp are symlinks to /private/{etc,var,tmp} on macOS —
  // matched against the realpath'd resolution (see resolvePath in
  // ./paths.ts), so both forms must be listed or canonicalization alone
  // would quietly route a system-directory write from "deny" to "ask".
  /^(\/etc|\/var|\/usr|\/System|\/Library|\/private\/etc|\/private\/var|\/private\/tmp)\//,
];

const ASK_READ_PATHS: RegExp[] = [/(^|\/)\.env(\.|$)/, /(~|\/)\.aws\//, /\.ssh\//, /id_rsa|id_ed25519/];

export function staticVerdict(tool: string, action: StaticAction, root: string): StaticVerdict {
  // Command-pattern checks are NOT an OS sandbox — they are a heuristic first line of defense.
  if (tool === "bash" && action.command) {
    const cmd = action.command;
    if (DENY_COMMANDS.some((re) => re.test(cmd))) return "deny";
    if (ASK_COMMANDS.some((re) => re.test(cmd))) return "ask";
    return null;
  }

  if (action.path) {
    // Same resolver execution uses (packages/core/src/paths.ts): the floor's
    // policy decision and the actual write/read target can never disagree
    // about what a path canonicalizes to.
    const path = resolvePath(root, action.path);
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
