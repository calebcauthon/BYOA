/**
 * Container backend — runs the session inside a Docker container (isolation
 * added; same Backend interface as local). This is where the clock-sync stops
 * being a no-op: `now()` reads the clock *inside* the container, which can differ
 * from the host, so pi's transcript timestamps get normalized onto the host
 * timeline via the offset the orchestrator already computes.
 *
 * M3 scope: a `local`-kind target is bind-mounted into the container at
 * /workspace, so edits/commits the agent makes land on the host repo (same
 * observable outcome as the local backend, just isolated). `docker exec` returns
 * the command's real exit code, so — like local — no completion sentinel is
 * needed here; that's reserved for the Daytona sandbox backend.
 *
 * Env knobs:
 *   AUTOMATIONS_CONTAINER_IMAGE  base image (default node:22 — has node+npm+git)
 *   AUTOMATIONS_KEEP_CONTAINER   keep the container after the run (debugging)
 */
import { spawn } from "node:child_process";
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

const IMAGE = process.env.AUTOMATIONS_CONTAINER_IMAGE ?? "node:22";
const WORKDIR = "/workspace";
const SCRATCH = "/agent-session";

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a process to completion, capturing output (for backend bookkeeping). */
function capture(bin: string, args: string[], input?: string): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

class ContainerBackend implements Backend {
  readonly kind = "container";
  private readonly settings: AgentSessionSettings;
  private containerId = "";

  constructor(settings: AgentSessionSettings) {
    this.settings = settings;
  }

  async prepare(settings: AgentSessionSettings, log: SessionLog): Promise<PreparedBackend> {
    if (settings.target.kind !== "local") {
      throw new Error("container backend (M3) supports only local-kind targets (bind-mounted)");
    }
    const repoPath = settings.target.repoPath;

    log.emit("backend", "info", `starting container from ${IMAGE}, mounting ${repoPath} → ${WORKDIR}`);
    const run = await capture("docker", [
      "run", "-d", "-w", WORKDIR, "-v", `${repoPath}:${WORKDIR}`, IMAGE, "sleep", "infinity",
    ]);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr.trim()}`);
    this.containerId = run.stdout.trim();
    log.emit("backend", "info", `container ${this.containerId.slice(0, 12)} up`);

    await this.dexec(["mkdir", "-p", SCRATCH], log);
    // git inside the container: trust the bind-mounted tree + give pi an identity
    // to commit with (the host owns the push; the agent only commits locally).
    await this.dexec(["git", "config", "--global", "--add", "safe.directory", WORKDIR], log);
    await this.dexec(["git", "config", "--global", "user.email", "agent@automations.local"], log);
    await this.dexec(["git", "config", "--global", "user.name", "automations agent"], log);

    const has = await capture("docker", ["exec", this.containerId, "sh", "-lc", "command -v pi || true"]);
    if (!has.stdout.trim()) {
      log.emit("backend", "info", "installing pi in container (npm i -g @mariozechner/pi-coding-agent)…");
      const inst = await capture("docker", [
        "exec", this.containerId, "sh", "-lc", "npm i -g @mariozechner/pi-coding-agent",
      ]);
      if (inst.code !== 0) throw new Error(`pi install failed: ${inst.stderr.slice(-2000)}`);
      log.emit("backend", "info", "pi installed");
    }

    return { workdir: WORKDIR, scratchDir: SCRATCH };
  }

  async now(log: SessionLog): Promise<number> {
    const r = await capture("docker", ["exec", this.containerId, "date", "+%s%3N"]);
    const epoch = Number(r.stdout.trim());
    log.emit(
      "backend",
      "debug",
      `clock probe: container wall-clock ${new Date(epoch).toISOString()} (epoch ${epoch}ms) — read via 'date' inside the box`,
      { epochMs: epoch },
    );
    return epoch;
  }

  /** docker exec helper for backend bookkeeping commands (not streamed). */
  private async dexec(cmd: string[], log: SessionLog): Promise<Captured> {
    const r = await capture("docker", ["exec", "-w", WORKDIR, this.containerId, ...cmd]);
    if (r.code !== 0) log.emit("backend", "warn", `container cmd failed (${cmd.join(" ")}): ${r.stderr.trim()}`);
    return r;
  }

  async exec(cmd: string[], opts: ExecOpts, log: SessionLog): Promise<ExecResult> {
    const src = opts.source ?? "orchestrator";
    const envFlags = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const dargs = [
      "exec",
      ...(opts.input !== undefined ? ["-i"] : []),
      ...envFlags,
      "-w", opts.cwd ?? WORKDIR,
      this.containerId,
      ...cmd,
    ];
    log.emit("orchestrator", "debug", `exec: ${redactStr(cmd.join(" "), opts.redact)}`, { cwd: opts.cwd ?? WORKDIR, source: src, via: "docker" });

    return await new Promise<ExecResult>((resolve) => {
      const child = spawn("docker", dargs);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const startedAt = Date.now();

      const heartbeat =
        opts.heartbeatMs && opts.heartbeatMs > 0
          ? setInterval(() => {
              const secs = Math.round((Date.now() - startedAt) / 1000);
              log.emit("backend", "info", `still running (${secs}s): ${cmd[0]}`);
            }, opts.heartbeatMs)
          : undefined;
      const timer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              log.emit("backend", "error", `timeout after ${opts.timeoutMs}ms — killing ${cmd[0]}`);
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

      if (opts.input !== undefined) child.stdin.write(opts.input);
      child.stdin.end();
    });
  }

  async readDir(dir: string, ext: string, _log: SessionLog): Promise<BackendFile[]> {
    const found = await capture("docker", [
      "exec", this.containerId, "sh", "-lc",
      `find ${dir} -type f -name '*${ext}' -printf '%T@\\t%p\\n' 2>/dev/null || true`,
    ]);
    const out: BackendFile[] = [];
    for (const line of found.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [mtime, path] = line.split("\t");
      if (!path) continue;
      const cat = await capture("docker", ["exec", this.containerId, "cat", path]);
      if (cat.code !== 0) continue;
      out.push({ path, content: cat.stdout, mtimeMs: Math.round(Number(mtime) * 1000) });
    }
    return out;
  }

  async readBytes(path: string, _log: SessionLog): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", this.containerId, "cat", path]);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`docker exec cat ${path} exited ${code}`))));
    });
  }

  async dispose(log: SessionLog): Promise<void> {
    if (!this.containerId) return;
    if (process.env.AUTOMATIONS_KEEP_CONTAINER) {
      log.emit("backend", "info", `keeping container ${this.containerId.slice(0, 12)} — docker exec -it ${this.containerId.slice(0, 12)} bash`);
      return;
    }
    await capture("docker", ["rm", "-f", this.containerId]);
    log.emit("backend", "info", `removed container ${this.containerId.slice(0, 12)}`);
  }
}

registerBackend("container", (settings) => new ContainerBackend(settings));
