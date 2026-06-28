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
import type { AgentSessionSettings } from "@automations/core";
import { registerBackend, type Backend, type ExecOpts, type ExecResult } from "./index.ts";
import type { SessionLog } from "../logging.ts";

class LocalBackend implements Backend {
  readonly kind = "local";
  private readonly settings: AgentSessionSettings;

  constructor(settings: AgentSessionSettings) {
    this.settings = settings;
  }

  async prepare(settings: AgentSessionSettings, log: SessionLog): Promise<{ workdir: string }> {
    const workdir = settings.target.kind === "local" ? settings.target.repoPath : process.cwd();
    log.emit("backend", "info", `local backend prepared (workdir=${workdir})`);
    // NB: the orchestrator owns branch/worktree creation (§4.1). Standalone, we
    // operate on whatever checkout we're handed.
    return { workdir };
  }

  async exec(cmd: string[], opts: ExecOpts, log: SessionLog): Promise<ExecResult> {
    const [bin, ...args] = cmd;
    if (!bin) throw new Error("exec: empty command");
    log.emit("workload", "info", `exec: ${cmd.join(" ")}`, { cwd: opts.cwd });

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
        log.emit("workload", "info", String(d).trimEnd());
      });
      child.stderr.on("data", (d) => {
        stderr += d;
        log.emit("workload", "warn", String(d).trimEnd());
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

  async dispose(log: SessionLog): Promise<void> {
    log.emit("backend", "info", "local backend: nothing to dispose");
  }
}

registerBackend("local", (settings) => new LocalBackend(settings));
