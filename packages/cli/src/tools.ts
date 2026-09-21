import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const OUTPUT_CAP = 50_000;
const READ_CAP = 100_000;
const BASH_STREAM_CAP = 256_000;

export interface ToolDeps {
  cwd: string;
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n... (truncated)` : text;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0DOUBLESTAR\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0DOUBLESTAR\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function makeTools(deps: ToolDeps): AgentTool[] {
  const bashParams = Type.Object({
      command: Type.String({ description: "The shell command to run" }),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 60000)" })),
    });

  function collectStream(stream: NodeJS.ReadableStream, limit: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let retained = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated: total > limit, bytes: retained });
      };
      stream.on("data", (d: Buffer) => {
        total += d.length;
        if (retained < limit) {
          const take = Math.min(d.length, limit - retained);
          chunks.push(d.subarray(0, take));
          retained += take;
        }
      });
      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", finish);
    });
  }

  const bash: AgentTool<typeof bashParams> = {
    name: "bash",
    label: "Bash",
    description: "Run a shell command in the project directory and return its output.",
    parameters: bashParams,
    execute: async (_id, params, signal) => {
      const started = performance.now();
      const timeoutSignal = AbortSignal.timeout(params.timeout_ms ?? 60_000);
      const kill = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const child = spawn("/bin/bash", ["-lc", params.command], {
        cwd: deps.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal: kill,
      });
      const stdout = collectStream(child.stdout!, BASH_STREAM_CAP);
      const stderr = collectStream(child.stderr!, BASH_STREAM_CAP);
      const spawnError = new Promise<Error | undefined>((resolve) => {
        child.on("error", (err) => resolve(err));
        child.on("close", () => resolve(undefined));
      });
      const code = await new Promise<number>((resolve) => {
        child.on("close", (c) => resolve(c ?? -1));
        child.on("error", () => {
          if (child.exitCode === null && child.signalCode === null) resolve(-1);
        });
      });
      const [out, err, error] = await Promise.all([stdout, stderr, spawnError]);
      child.removeAllListeners();
      const durationMs = Math.round(performance.now() - started);
      const combined = cap(`${out.text}${err.text}`.trim(), OUTPUT_CAP);
      const truncated = out.truncated || err.truncated;

      // Node emits an AbortError on the child when the kill signal fires; only
      // non-abort errors are spawn-level failures.
      if (error && !signal?.aborted && !timeoutSignal.aborted) {
        return {
          content: [{ type: "text", text: cap(`${error.message}\n${err.text}`.trim(), OUTPUT_CAP) || "(no output)" }],
          details: { exit: -1, status: "error" as const, durationMs, truncated, stdoutBytes: out.bytes, stderrBytes: err.bytes },
        };
      }

      const status = signal?.aborted
        ? ("cancelled" as const)
        : timeoutSignal.aborted
          ? ("timeout" as const)
          : code === 0
            ? ("ok" as const)
            : ("error" as const);

      return {
        content: [{ type: "text", text: combined || "(no output)" }],
        details: { exit: code, status, durationMs, truncated, stdoutBytes: out.bytes, stderrBytes: err.bytes },
      };
    },
  };

  const readParams = Type.Object({
      path: Type.String({ description: "File path, relative to the project directory" }),
    });
  const read: AgentTool<typeof readParams> = {
    name: "read",
    label: "Read File",
    description: "Read a file's contents.",
    parameters: readParams,
    executionMode: "parallel",
    execute: async (_id, params) => {
      const path = join(deps.cwd, params.path);
      const text = readFileSync(path, "utf8");
      return { content: [{ type: "text", text: cap(text, READ_CAP) }], details: { path: params.path } };
    },
  };

  const writeParams = Type.Object({
      path: Type.String({ description: "File path, relative to the project directory" }),
      content: Type.String({ description: "Full file content to write" }),
    });
  const write: AgentTool<typeof writeParams> = {
    name: "write",
    label: "Write File",
    description: "Create or overwrite a file with the given content.",
    parameters: writeParams,
    execute: async (_id, params) => {
      const path = join(deps.cwd, params.path);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, params.content, "utf8");
      return {
        content: [{ type: "text", text: `wrote ${params.path} (${params.content.length} bytes)` }],
        details: { path: params.path, bytes: params.content.length },
      };
    },
  };

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (statSync(full).size < 1_000_000) yield full;
    }
  }

  const grepParams = Type.Object({
      pattern: Type.String({ description: "Regular expression to search for" }),
      path: Type.Optional(Type.String({ description: "Directory to search (default: project root)" })),
    });
  const grep: AgentTool<typeof grepParams> = {
    name: "grep",
    label: "Grep",
    description: "Search file contents with a regular expression.",
    parameters: grepParams,
    executionMode: "parallel",
    execute: async (_id, params) => {
      const base = join(deps.cwd, params.path ?? ".");
      const re = new RegExp(params.pattern);
      const matches: string[] = [];
      for (const file of walk(base)) {
        if (matches.length >= 200) break;
        let lines: string[];
        try {
          lines = readFileSync(file, "utf8").split("\n");
        } catch {
          continue;
        }
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            matches.push(`${relative(deps.cwd, file)}:${i + 1}: ${lines[i]!.trim()}`);
            if (matches.length >= 200) break;
          }
        }
      }
      return {
        content: [{ type: "text", text: matches.length > 0 ? matches.join("\n") : "(no matches)" }],
        details: { count: matches.length },
      };
    },
  };

  const globParams = Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. src/**/*.ts" }),
    });
  const glob: AgentTool<typeof globParams> = {
    name: "glob",
    label: "Glob",
    description: "List files matching a glob pattern.",
    parameters: globParams,
    executionMode: "parallel",
    execute: async (_id, params) => {
      const re = globToRegex(params.pattern);
      const files: string[] = [];
      for (const path of walk(deps.cwd)) {
        const rel = relative(deps.cwd, path);
        if (re.test(rel)) {
          files.push(rel);
          if (files.length >= 500) break;
        }
      }
      return {
        content: [{ type: "text", text: files.length > 0 ? files.sort().join("\n") : "(no matches)" }],
        details: { count: files.length },
      };
    },
  };

  return [bash, read, write, grep, glob];
}
