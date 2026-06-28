/**
 * Daytona (cloud sandbox) backend — same Backend interface, no host filesystem.
 *
 * THE big difference from the container backend: you cannot bind-mount. The
 * working tree has to get INTO the remote sandbox and the transcript has to come
 * back OUT, both over the Daytona SDK:
 *   • local target  → tar the repo on the host, upload it, extract in /workspace
 *   • remote target → git.clone into /workspace
 *   • prompt (stdin) → uploaded to a file + redirected (executeCommand has no stdin)
 *   • transcript     → read back via exec(find)+exec(cat) in readDir
 *
 * Commits the agent makes live in the sandbox and stay there until something
 * pushes them out (the GitHub liaison, later) — there is no host repo to reflect
 * them, unlike local/container.
 *
 * Env: DAYTONA_API_KEY (required), AUTOMATIONS_SANDBOX_IMAGE (default node:22),
 *      AUTOMATIONS_KEEP_SANDBOX (keep the sandbox for debugging).
 *
 * NOTE: uses the synchronous executeCommand (blocks, returns a real exit code).
 * If long runs start hitting gateway timeouts we'd switch to the async
 * session API + completion sentinel (ADR-0001 Decision 5) — not needed yet.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daytona, Image, type Sandbox, type CreateSandboxFromImageParams } from "@daytonaio/sdk";
import type { AgentSessionSettings } from "@automations/core";
import {
  registerBackend,
  type Backend,
  type BackendFile,
  type ExecOpts,
  type ExecResult,
  type PreparedBackend,
} from "./index.ts";
import type { SessionLog } from "../logging.ts";

const IMAGE = process.env.AUTOMATIONS_SANDBOX_IMAGE ?? "node:22";
const WORKDIR = "/workspace";
const SCRATCH = "/agent-session";

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function hostTar(repoPath: string): Promise<string> {
  const tgz = join(mkdtempSync(join(tmpdir(), "daytona-up-")), "repo.tgz");
  return new Promise((resolve, reject) => {
    // Include .git (so the agent can commit / we can read HEAD); skip our own
    // scratch + deps. -C repoPath . tars the working tree.
    const child = spawn("tar", ["--exclude=./.session", "--exclude=./node_modules", "-czf", tgz, "-C", repoPath, "."]);
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(tgz) : reject(new Error(`tar failed: ${err}`))));
  });
}

class DaytonaBackend implements Backend {
  readonly kind = "daytona";
  private readonly settings: AgentSessionSettings;
  private daytona: Daytona | undefined;
  private sandbox: Sandbox | undefined;

  constructor(settings: AgentSessionSettings) {
    this.settings = settings;
  }

  private box(): Sandbox {
    if (!this.sandbox) throw new Error("daytona sandbox not prepared");
    return this.sandbox;
  }

  /** Raw executeCommand for setup/bookkeeping. No cwd by default — passing a cwd
   *  that doesn't exist yet (e.g. /workspace before we create it) makes the
   *  toolbox fail with a misleading "fork/exec /usr/bin/bash" error. */
  private async run(command: string, log: SessionLog, env?: Record<string, string>, timeoutMs?: number, cwd?: string): Promise<ExecResult> {
    const startedAt = Date.now();
    const hb = setInterval(() => log.emit("backend", "info", `still running (${Math.round((Date.now() - startedAt) / 1000)}s) in sandbox`), 30_000);
    try {
      const r = await this.box().process.executeCommand(command, cwd, env, timeoutMs ? Math.ceil(timeoutMs / 1000) : undefined);
      return { exitCode: r.exitCode, stdout: r.result ?? "", stderr: "" };
    } finally {
      clearInterval(hb);
    }
  }

  /** Run a setup command and throw with context if it fails. */
  private async must(command: string, log: SessionLog, timeoutMs?: number): Promise<string> {
    const r = await this.run(command, log, undefined, timeoutMs);
    if (r.exitCode !== 0) throw new Error(`sandbox setup failed (${command.slice(0, 60)}…): exit ${r.exitCode}: ${r.stdout.slice(-500)}`);
    return r.stdout;
  }

  async prepare(settings: AgentSessionSettings, log: SessionLog): Promise<PreparedBackend> {
    if (!process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY is not set");
    this.daytona = new Daytona();
    // Bake the toolchain INTO the image (pi on a node base that already has
    // git/bash/curl), mirroring the prototype's build_image. Passing
    // onSnapshotCreateLogs makes the SDK WAIT for the image build to finish —
    // without it the sandbox comes up on a minimal default image (no bash).
    log.emit("backend", "info", `building sandbox image from ${IMAGE} (pi baked in)…`);
    const image = Image.base(IMAGE).runCommands("npm install -g @mariozechner/pi-coding-agent");
    const params = { image } as CreateSandboxFromImageParams;
    this.sandbox = await this.daytona.create(params, {
      timeout: 600,
      onSnapshotCreateLogs: (line: string) => {
        const t = line.trim();
        if (t) log.emit("backend", "debug", `[image build] ${t}`);
      },
    });
    log.emit("backend", "info", `sandbox ${this.sandbox.id} ready`);

    // Create dirs FIRST (no cwd — /workspace doesn't exist yet).
    await this.must(`mkdir -p ${WORKDIR} ${SCRATCH}`, log);

    // Get the working tree IN (no bind mount).
    if (settings.target.kind === "local") {
      log.emit("backend", "info", `uploading local repo ${settings.target.repoPath} → ${WORKDIR} (tar+upload, no bind mount)`);
      const tgz = await hostTar(settings.target.repoPath);
      await this.sandbox.fs.uploadFile(tgz, "/tmp/repo.tgz");
      await this.must(`tar xzf /tmp/repo.tgz -C ${WORKDIR}`, log);
    } else {
      const url = `https://github.com/${settings.target.repo}.git`;
      log.emit("backend", "info", `cloning ${url} (branch ${settings.target.branch}) → ${WORKDIR}`);
      await this.sandbox.git.clone(url, WORKDIR, settings.target.branch);
    }

    // git identity so the agent can commit (host owns the push); trust the tree.
    await this.must(
      `git config --global --add safe.directory ${WORKDIR} && ` +
        `git config --global user.email agent@automations.local && ` +
        `git config --global user.name 'automations agent'`,
      log,
    );

    return { workdir: WORKDIR, scratchDir: SCRATCH };
  }

  async now(log: SessionLog): Promise<number> {
    const r = await this.run(`date +%s%3N`, log);
    const raw = r.stdout.trim();
    const epoch = Number(raw);
    if (!Number.isFinite(epoch) || epoch <= 0) {
      log.emit("backend", "warn", `clock probe: could not parse sandbox time (raw=${JSON.stringify(raw).slice(0, 120)}); falling back to host clock`, {
        raw,
      });
      return Date.now();
    }
    log.emit("backend", "debug", `clock probe: sandbox wall-clock ${new Date(epoch).toISOString()} (epoch ${epoch}ms) — read inside the Daytona sandbox`, {
      epochMs: epoch,
    });
    return epoch;
  }

  async exec(cmd: string[], opts: ExecOpts, log: SessionLog): Promise<ExecResult> {
    const src = opts.source ?? "orchestrator";
    let command = cmd.map(shq).join(" ");

    // executeCommand has no stdin — upload the input to a file and redirect.
    if (opts.input !== undefined) {
      const remote = `/tmp/stdin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await this.box().fs.uploadFile(Buffer.from(opts.input, "utf8"), remote);
      command = `${command} < ${shq(remote)}`;
    }

    log.emit("orchestrator", "debug", `exec: ${cmd.join(" ")}`, { cwd: opts.cwd ?? WORKDIR, source: src, via: "daytona" });
    const startedAt = Date.now();
    const hb =
      opts.heartbeatMs && opts.heartbeatMs > 0
        ? setInterval(() => log.emit("backend", "info", `still running (${Math.round((Date.now() - startedAt) / 1000)}s): ${cmd[0]}`), opts.heartbeatMs)
        : undefined;
    try {
      const r = await this.box().process.executeCommand(command, opts.cwd ?? WORKDIR, opts.env, opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : undefined);
      const stdout = r.result ?? "";
      opts.onStdout?.(stdout);
      if (opts.logStdout !== false && stdout.trim()) log.emit(src, "info", stdout.trimEnd());
      return { exitCode: r.exitCode, stdout, stderr: "" };
    } finally {
      if (hb) clearInterval(hb);
    }
  }

  async readDir(dir: string, ext: string, _log: SessionLog): Promise<BackendFile[]> {
    const found = await this.box().process.executeCommand(
      `find ${dir} -type f -name '*${ext}' -printf '%T@\\t%p\\n' 2>/dev/null || true`,
      WORKDIR,
    );
    const out: BackendFile[] = [];
    for (const line of (found.result ?? "").split("\n")) {
      if (!line.trim()) continue;
      const [mtime, path] = line.split("\t");
      if (!path) continue;
      const buf = await this.box().fs.downloadFile(path);
      out.push({ path, content: buf.toString("utf8"), mtimeMs: Math.round(Number(mtime) * 1000) });
    }
    return out;
  }

  async dispose(log: SessionLog): Promise<void> {
    if (!this.sandbox || !this.daytona) return;
    if (process.env.AUTOMATIONS_KEEP_SANDBOX) {
      log.emit("backend", "info", `keeping sandbox ${this.sandbox.id} — daytona sandbox ssh ${this.sandbox.id}`);
      return;
    }
    await this.daytona.delete(this.sandbox);
    log.emit("backend", "info", `deleted sandbox ${this.sandbox.id}`);
  }
}

registerBackend("daytona", (settings) => new DaytonaBackend(settings));
