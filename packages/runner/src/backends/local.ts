/**
 * Local (bare-metal) backend — runs commands directly on this machine.
 * The simplest backend and the one implemented first (M1): container + sandbox
 * are the same interface with isolation added.
 *
 * Local spawn gives a reliable exit code, so we don't need the completion
 * sentinel here — but we DO add the wall-clock timeout + heartbeat (§2.7) so the
 * exec contract is identical to what the sandbox backend will need.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSessionSettings } from "@automations/core";
import {
  redactStr,
  registerBackend,
  type Backend,
  type BackendFile,
  type ExecOpts,
  type ExecResult,
  type PreparedBackend,
} from "./index.ts";
import type { SessionLog } from "../logging.ts";

class LocalBackend implements Backend {
  readonly kind = "local";
  private readonly settings: AgentSessionSettings;

  constructor(settings: AgentSessionSettings) {
    this.settings = settings;
  }

  async prepare(settings: AgentSessionSettings, log: SessionLog): Promise<PreparedBackend> {
    // The backend reporting about ITSELF (backend provenance): what it set up.
    // Distinct from the orchestrator's "backend ready" boundary line emitted
    // after this returns. Adapters with real setup (sandbox: create box, clone,
    // install) report those steps here too.
    // NB: the orchestrator owns branch/worktree creation (§4.1). Standalone, we
    // operate on whatever checkout we're handed.
    const workdir = settings.target.kind === "local" ? settings.target.repoPath : process.cwd();
    const scratchDir = mkdtempSync(join(tmpdir(), "agent-session-"));
    log.emit("backend", "info", `prepared local backend; workdir ${workdir}; scratch ${scratchDir}`, {
      workdir,
      scratchDir,
    });
    return { workdir, scratchDir };
  }

  async now(log: SessionLog): Promise<number> {
    // Bare metal shares the host clock; offset will be ~0. A real sandbox would
    // run `date +%s%3N` inside the box here, and the reading could differ.
    const epoch = Date.now();
    log.emit("backend", "debug", `clock probe: backend wall-clock ${new Date(epoch).toISOString()} (epoch ${epoch}ms) — local shares the host clock`, {
      epochMs: epoch,
    });
    return epoch;
  }

  async exec(cmd: string[], opts: ExecOpts, log: SessionLog): Promise<ExecResult> {
    const [bin, ...args] = cmd;
    if (!bin) throw new Error("exec: empty command");
    // The command's output belongs to whatever the caller says it is (§3.2);
    // the "exec:" announcement is always runner bookkeeping.
    const src = opts.source ?? "orchestrator";
    log.emit("orchestrator", "debug", `exec: ${redactStr(cmd.join(" "), opts.redact)}`, { cwd: opts.cwd, source: src });

    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const startedAt = Date.now();
      const heartbeat =
        opts.heartbeatMs && opts.heartbeatMs > 0
          ? setInterval(() => {
              const secs = Math.round((Date.now() - startedAt) / 1000);
              log.emit("backend", "info", `still running (${secs}s): ${bin}`);
            }, opts.heartbeatMs)
          : undefined;

      const timer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              log.emit("backend", "error", `timeout after ${opts.timeoutMs}ms — killing ${bin}`);
              child.kill("SIGKILL");
            }, opts.timeoutMs)
          : undefined;

      child.stdout.on("data", (d) => {
        stdout += d;
        opts.onStdout?.(String(d));
        if (opts.logStdout !== false) log.emit(src, "info", redactStr(String(d).trimEnd(), opts.redact));
      });
      child.stderr.on("data", (d) => {
        stderr += d;
        log.emit(src, "warn", redactStr(String(d).trimEnd(), opts.redact));
      });

      child.on("close", (code) => {
        if (heartbeat) clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });

      if (opts.input !== undefined) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    });
  }

  async readDir(dir: string, ext: string, _log: SessionLog): Promise<BackendFile[]> {
    let names: string[] = [];
    try {
      names = readdirSync(dir, { recursive: true, encoding: "utf8" });
    } catch {
      return [];
    }
    const out: BackendFile[] = [];
    for (const name of names) {
      if (!name.endsWith(ext)) continue;
      const path = join(dir, name);
      try {
        out.push({ path, content: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  async readBytes(path: string, _log: SessionLog): Promise<Buffer> {
    return readFileSync(path);
  }

  async dispose(log: SessionLog): Promise<void> {
    log.emit("backend", "info", "local backend: nothing to dispose");
  }
}

registerBackend("local", (settings) => new LocalBackend(settings));
