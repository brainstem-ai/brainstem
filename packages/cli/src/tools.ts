import { Type } from "@sinclair/typebox";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { writeFileVerified } from "./paths";

const READ_CAP_BYTES = 100_000;
const BASH_STREAM_CAP = 256_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_DRAIN_GRACE_MS = 500;

export interface ToolDeps {
  cwd: string;
  /** Grace period between SIGTERM and SIGKILL for a managed process group. Test-only override; production uses the 2s default. */
  killGraceMs?: number;
  /** Extra bound on waiting for stdio pipes to close after SIGKILL, so a lingering descendant cannot hang the tool call. */
  drainGraceMs?: number;
}

/** Bounded file read: reads at most `capBytes` from disk without loading the whole file, and never splits a UTF-8 sequence at the boundary. */
function readBounded(path: string, capBytes: number): { text: string; truncated: boolean; sourceBytes: number } {
  const fd = openSync(path, "r");
  try {
    const sourceBytes = fstatSync(fd).size;
    const toRead = Math.min(sourceBytes, capBytes);
    const buf = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const n = readSync(fd, buf, offset, toRead - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const truncated = sourceBytes > capBytes;
    let end = offset;
    if (truncated && end > 0) {
      // Back up over a continuation byte, then (if the lead byte's declared
      // sequence length would run past `end`) over the lead byte too, so the
      // returned text never ends mid-codepoint.
      while (end > 0 && (buf[end - 1]! & 0b1100_0000) === 0b1000_0000) end -= 1;
      if (end > 0) {
        const lead = buf[end - 1]!;
        const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (seqLen > 1 && offset - (end - 1) < seqLen) end -= 1;
      }
    }
    return { text: buf.subarray(0, end).toString("utf8"), truncated, sourceBytes };
  } finally {
    closeSync(fd);
  }
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

  interface StreamCollection {
    text: string;
    truncated: boolean;
    retainedBytes: number;
    observedBytes: number;
    /** false only when drainage was force-cut by the cleanup bound rather than the stream closing on its own. */
    complete: boolean;
  }

  function collectStream(stream: NodeJS.ReadableStream, limit: number): { result: Promise<StreamCollection>; forceFinish: () => void } {
    let settle!: (v: StreamCollection) => void;
    const result = new Promise<StreamCollection>((resolve) => {
      settle = resolve;
    });
    const chunks: Buffer[] = [];
    let observedBytes = 0;
    let retainedBytes = 0;
    let done = false;
    const finish = (complete: boolean) => {
      if (done) return;
      done = true;
      settle({ text: Buffer.concat(chunks).toString("utf8"), truncated: observedBytes > limit, retainedBytes, observedBytes, complete });
    };
    stream.on("data", (d: Buffer) => {
      observedBytes += d.length;
      if (retainedBytes < limit) {
        const take = Math.min(d.length, limit - retainedBytes);
        chunks.push(d.subarray(0, take));
        retainedBytes += take;
      }
    });
    stream.on("end", () => finish(true));
    stream.on("close", () => finish(true));
    stream.on("error", () => finish(true));
    return { result, forceFinish: () => finish(false) };
  }

  const bash: AgentTool<typeof bashParams> = {
    name: "bash",
    label: "Bash",
    description: "Run a shell command in the project directory and return its output.",
    parameters: bashParams,
    execute: async (_id, params, signal) => {
      const started = performance.now();

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "" }],
          details: {
            exit: -1,
            status: "cancelled" as const,
            durationMs: 0,
            truncated: false,
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutText: "",
            stderrText: "",
            stdoutComplete: true,
            stderrComplete: true,
          },
        };
      }

      const timeoutMs = params.timeout_ms ?? 60_000;
      const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      const drainGraceMs = deps.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
      // On supported POSIX platforms the child is made the leader of its own
      // process group (detached: true does this without unref-ing or
      // detaching from our own stdio pipes), so termination can target the
      // whole group via process.kill(-pid, sig) rather than only the direct
      // child — spawn({ signal }) alone only ever reaches the immediate
      // shell, not its descendants. Windows has no process-group kill
      // primitive here, so it falls back to killing only the direct child;
      // this is a documented platform limitation, not process-tree
      // containment (see README).
      const posix = process.platform !== "win32";
      const child = spawn("/bin/bash", ["-lc", params.command], {
        cwd: deps.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: posix,
      });

      const stdoutCollector = collectStream(child.stdout!, BASH_STREAM_CAP);
      const stderrCollector = collectStream(child.stderr!, BASH_STREAM_CAP);

      let killedBy: "timeout" | "cancelled" | undefined;

      const killGroup = (sig: NodeJS.Signals) => {
        if (posix && child.pid !== undefined) {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch {
            // As of Bun 1.1.6, process.kill() rejects a negative pid with a
            // RangeError before it ever reaches the kill(2) syscall — it
            // never actually attempts a process-group signal, unlike Node.
            // Shell out to the kill(1) binary instead, which parses "-pid"
            // as a process-group target at the OS level and is unaffected
            // by that validation. This is what actually makes group
            // termination (as opposed to only killing the direct child)
            // work under Bun; verify this workaround is still required (or
            // still correct) on Bun upgrade.
          }
          try {
            const signalName = sig.startsWith("SIG") ? sig.slice(3) : sig;
            execFileSync("kill", [`-${signalName}`, "--", `-${child.pid}`], { stdio: "ignore" });
            return;
          } catch {
            // No such process group (already gone) — fall back below.
          }
        }
        try {
          child.kill(sig);
        } catch {
          // Process already exited; nothing to signal.
        }
      };

      let spawnErrorMessage: string | undefined;
      const spawnErrorPromise = new Promise<void>((resolve) => {
        child.once("error", (err) => {
          spawnErrorMessage = err.message;
          resolve();
        });
        child.once("spawn", () => resolve());
      });

      // "exit" (not "close"): "close" additionally waits for the child's own
      // stdio streams to end, which never happens if a descendant that
      // inherited those same pipe fds (e.g. one that detaches via setsid()
      // without redirecting its own stdio) is still holding them open —
      // that would make waiting for the direct child's own exit silently
      // degrade into waiting for that unrelated descendant to finish on its
      // own, defeating the whole point of a bounded kill sequence. "exit"
      // fires as soon as the OS process itself has terminated, independent
      // of pipe state; pipe completion is handled separately (and bounded)
      // by stdoutCollector/stderrCollector below.
      const exitPromise = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
      });
      // The DIRECT child settling (exit + spawn outcome) is distinct from
      // the whole managed GROUP being gone — a backgrounded group member
      // with redirected (or otherwise independent) stdio can outlive the
      // shell that spawned it even after that shell has exited.
      const directChildSettled = Promise.all([exitPromise, spawnErrorPromise]);

      let killGraceTimer: ReturnType<typeof setTimeout> | undefined;
      const triggerKill = (reason: "timeout" | "cancelled") => {
        if (killedBy) return;
        killedBy = reason;
        killGroup("SIGTERM");
        // Whichever happens first — the direct child settling on its own,
        // or the grace period elapsing — immediately send SIGKILL to the
        // whole group. Racing against the direct child's own exit (instead
        // of only firing on a fixed timer) means a direct child that dies
        // quickly from SIGTERM (e.g. it has no trap, while a sibling in the
        // same group does) doesn't leave that sibling alive for the rest of
        // the grace window; a child that itself ignores SIGTERM is still
        // forced once the grace period elapses. This also keeps ordinary
        // (no-straggler) cancellations fast: SIGKILL and the bounded drain
        // wait fire right after the direct child exits, not after a fixed
        // multi-second grace period regardless of how fast it actually died.
        let proceeded = false;
        const proceedToKill = () => {
          if (proceeded) return;
          proceeded = true;
          if (killGraceTimer) clearTimeout(killGraceTimer);
          killGroup("SIGKILL");
          // Bound pipe drainage: a descendant outside the group (detached)
          // or one that still holds a pipe open past SIGKILL cannot hang
          // this tool call past the cleanup allowance.
          setTimeout(() => {
            stdoutCollector.forceFinish();
            stderrCollector.forceFinish();
          }, drainGraceMs);
        };
        directChildSettled.then(proceedToKill);
        killGraceTimer = setTimeout(proceedToKill, killGraceMs);
      };

      const timeoutTimer = setTimeout(() => triggerKill("timeout"), timeoutMs);
      const onCallerAbort = () => triggerKill("cancelled");
      signal?.addEventListener("abort", onCallerAbort, { once: true });

      const [code] = await Promise.all([exitPromise, spawnErrorPromise]);
      const [out, err] = await Promise.all([stdoutCollector.result, stderrCollector.result]);

      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      signal?.removeEventListener("abort", onCallerAbort);
      child.removeAllListeners();

      const durationMs = Math.round(performance.now() - started);

      if (spawnErrorMessage !== undefined && !killedBy) {
        return {
          content: [{ type: "text", text: spawnErrorMessage }],
          details: {
            exit: -1,
            status: "error" as const,
            durationMs,
            truncated: false,
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutText: "",
            stderrText: "",
            stdoutComplete: true,
            stderrComplete: true,
          },
        };
      }

      const status = killedBy === "cancelled" ? ("cancelled" as const) : killedBy === "timeout" ? ("timeout" as const) : code === 0 ? ("ok" as const) : ("error" as const);
      // Distinct from R1's presentation truncation: this is the CAPTURE
      // completeness contract — true only when both streams closed on their
      // own within their retention cap, never display-clipped afterward.
      const truncated = out.truncated || err.truncated || !out.complete || !err.complete;

      return {
        // Concatenation here does not claim to reconstruct temporal
        // interleaving between stdout and stderr — the harness archives them
        // as separate named streams (details.stdoutText/stderrText); this is
        // only the combined text shown to the model when no artifact
        // presentation layer intervenes.
        content: [{ type: "text", text: `${out.text}${err.text}` }],
        details: {
          exit: killedBy ? -1 : (code ?? -1),
          status,
          durationMs,
          truncated,
          stdoutBytes: out.retainedBytes,
          stderrBytes: err.retainedBytes,
          stdoutText: out.text,
          stderrText: err.text,
          stdoutObservedBytes: out.observedBytes,
          stderrObservedBytes: err.observedBytes,
          stdoutComplete: out.complete && !out.truncated,
          stderrComplete: err.complete && !err.truncated,
        },
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
      // Bounded streaming read: never loads more than READ_CAP_BYTES into
      // memory, even for a huge file, rather than reading it whole and
      // clipping afterward. The truncation notice is presentation-layer
      // wording added by the harness, not baked in here, so the archived
      // capture (== this returned text) stays free of presentation text.
      const { text, truncated, sourceBytes } = readBounded(path, READ_CAP_BYTES);
      return {
        content: [{ type: "text", text }],
        details: { path: params.path, truncated, sourceBytes, retainedBytes: Buffer.byteLength(text, "utf8") },
      };
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
      // The tool is itself a "managed executor" for R2/R3: it resolves and
      // verifies the same canonical target the gate/approval layer checked,
      // and writes through an atomic verified path rather than a bare
      // join(cwd, path) + writeFileSync that could target a symlink the
      // gate never saw. This runs even when the harness's own gate already
      // checked the same thing, as defense in depth for direct callers.
      const result = writeFileVerified(deps.cwd, params.path, params.content);
      if (!result.ok) {
        throw new Error(`write blocked: ${result.reason}`);
      }
      return {
        content: [{ type: "text", text: `wrote ${params.path} (${result.bytesWritten} bytes)` }],
        details: { path: params.path, bytes: result.bytesWritten, resolvedTarget: result.resolvedTarget },
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
      let truncated = false;
      outer: for (const file of walk(base)) {
        let lines: string[];
        try {
          lines = readFileSync(file, "utf8").split("\n");
        } catch {
          continue;
        }
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            if (matches.length >= 200) {
              truncated = true;
              break outer;
            }
            matches.push(`${relative(deps.cwd, file)}:${i + 1}: ${lines[i]!.trim()}`);
          }
        }
      }
      return {
        content: [{ type: "text", text: matches.length > 0 ? matches.join("\n") : "(no matches)" }],
        // `truncated: true` means enumeration itself stopped early — matches
        // beyond the 200-result cap were never scanned for, not merely
        // omitted from display.
        details: { count: matches.length, truncated },
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
      let truncated = false;
      for (const path of walk(deps.cwd)) {
        const rel = relative(deps.cwd, path);
        if (re.test(rel)) {
          if (files.length >= 500) {
            truncated = true;
            break;
          }
          files.push(rel);
        }
      }
      return {
        content: [{ type: "text", text: files.length > 0 ? files.sort().join("\n") : "(no matches)" }],
        details: { count: files.length, truncated },
      };
    },
  };

  return [bash, read, write, grep, glob];
}
