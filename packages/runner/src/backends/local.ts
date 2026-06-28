/**
 * Local (bare-metal) backend — runs commands directly on this machine.
 * The simplest backend and the one to implement first (M1): everything else
 * (container, sandbox) is the same interface with isolation added.
 */
import { spawn } from "node:child_process";
import type { AgentSessionSettings } from "@automations/core";
import { registerBackend, type Backend, type ExecResult } from "./index.ts";
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
    // TODO(M1): orchestrator owns branch/worktree creation; this just uses the
    // checkout it is handed. Verify it exists + is on the requested branch.
    return { workdir };
  }

  async exec(cmd: string[], opts: { cwd?: string }, log: SessionLog): Promise<ExecResult> {
    log.emit("workload", "info", `exec: ${cmd.join(" ")}`, { cwd: opts.cwd });
    return new Promise((resolve) => {
      const [bin, ...args] = cmd;
      const child = spawn(bin!, args, { cwd: opts.cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
        log.emit("workload", "info", String(d).trimEnd());
      });
      child.stderr.on("data", (d) => {
        stderr += d;
        log.emit("workload", "warn", String(d).trimEnd());
      });
      child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    });
  }

  async dispose(log: SessionLog): Promise<void> {
    log.emit("backend", "info", "local backend: nothing to dispose");
  }
}

registerBackend("local", (settings) => new LocalBackend(settings));
