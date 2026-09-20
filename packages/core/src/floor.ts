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
  /^(\/etc|\/var|\/usr|\/System|\/Library)\//,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.aws\//,
  /id_rsa|id_ed25519|authorized_keys|\.ssh\//,
];

const ASK_WRITE_PATHS: RegExp[] = [/^\.\.\//, /^\/tmp\//, /^\//];

const ASK_READ_PATHS: RegExp[] = [
  /(^|\/)\.env(\.|$)/,
  /(~|\/)\.aws\//,
  /\.ssh\//,
  /id_rsa|id_ed25519/,
];

function normalizePath(path: string): string {
  return path.replace(/^~(?=\/|$)/, `${process.env.HOME ?? "~"}`);
}

export function staticVerdict(tool: string, action: StaticAction): StaticVerdict {
  if (tool === "bash" && action.command) {
    const cmd = action.command;
    if (DENY_COMMANDS.some((re) => re.test(cmd))) return "deny";
    if (ASK_COMMANDS.some((re) => re.test(cmd))) return "ask";
    return null;
  }

  if (action.path) {
    const path = normalizePath(action.path);
    const home = process.env.HOME ?? "";
    const inProject = !path.startsWith("/") || path.startsWith(process.cwd());
    const underHome = home !== "" && (path === home || path.startsWith(home + "/"));

    if (tool === "write") {
      if (DENY_WRITE_PATHS.some((re) => re.test(path))) return "deny";
      if (!inProject && !underHome) return "ask";
      if (ASK_WRITE_PATHS.some((re) => re.test(path)) && !path.startsWith(process.cwd())) return "ask";
      return null;
    }

    if (tool === "read" || tool === "grep" || tool === "glob") {
      if (ASK_READ_PATHS.some((re) => re.test(path))) return "ask";
      return null;
    }
  }

  return null;
}
