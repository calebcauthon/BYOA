/**
 * Daytona (cloud sandbox) backend — same Backend interface, no host filesystem.
 *
 * THE big difference from the container backend: you cannot bind-mount. The
 * working tree has to get INTO the remote sandbox and the transcript has to come
 * back OUT, both over the Daytona SDK:
 *   • local target  → tar the repo on the host, upload it, extract in /workspace
 *   • remote target → git.clone into /workspace
 *   • prompt (stdin) → uploaded to a file + redirected (session exec has no stdin)
 *   • transcript     → read back via exec(find)+exec(cat) in readDir
 *
 * Commits the agent makes live in the sandbox and stay there until something
 * pushes them out (the GitHub liaison, later) — there is no host repo to reflect
 * them, unlike local/container.
 *
 * Env: DAYTONA_API_KEY (required), AUTOMATIONS_SANDBOX_IMAGE (default node:22),
 *      AUTOMATIONS_KEEP_SANDBOX (keep the sandbox for debugging).
 *
 * Agent commands use Daytona's async session API and a completion sentinel.
 * This avoids holding one HTTP response open for a long run and gives the host
 * a real wall-clock timeout even when Daytona's command exitCode stays unset.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daytona, Image, type Sandbox, type CreateSandboxFromImageParams } from "@daytonaio/sdk";
import type { AgentSessionSettings, Credentials, IgnoreKind } from "@automations/core";
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

const IMAGE = process.env.AUTOMATIONS_SANDBOX_IMAGE ?? "node:22";
const WORKDIR = "/workspace";
const SCRATCH = "/agent-session";
const SESSION_POLL_MS = 1_000;

// Sandbox-closing safety net (see docs/saas-plan.md Phase 1.5). Every sandbox we
// create is TAGGED so a reaper can find it, and given Daytona-side auto-cleanup so
// a leaked sandbox self-destructs even if our process dies before dispose() runs
// (a Railway deploy/SIGKILL). autoStop stops it after N idle minutes; autoDelete
// then removes the stopped sandbox so it stops billing. KEEP disables both.
const MANAGED_LABEL = "automations.managed";
const KEEP_SANDBOX = !!process.env.AUTOMATIONS_KEEP_SANDBOX;
const AUTO_STOP_MIN = Number(process.env.AUTOMATIONS_SANDBOX_AUTOSTOP_MIN ?? 15);
const AUTO_DELETE_MIN = Number(process.env.AUTOMATIONS_SANDBOX_AUTODELETE_MIN ?? 15);

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const execFileAsync = promisify(execFile);

// A GitHub token so the sandbox can clone private repos (unauthenticated clones
// 404 as "Repository not found"). Prefer the principal's token (a GitHub App
// installation token in hosted mode); fall back to the host `gh` CLI so local
// single-operator runs are unchanged. Empty if neither is available — public
// repos still clone without it.
async function ghToken(credentials?: Credentials): Promise<string> {
  if (credentials?.githubToken) return credentials.githubToken;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args);
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar failed: ${err.trim()}`))));
  });
}

function capStdout(bin: string, args: string[]): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d as Buffer));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks) }));
    child.on("error", () => resolve({ code: -1, stdout: Buffer.alloc(0) }));
  });
}

/**
 * Tar the host repo for upload. `respect` opts in to ignore files (only copy-
 * based backends like this one need it — see AgentSessionSettings.respectIgnore):
 *   gitignore   → use `git ls-files -co --exclude-standard` (accurate: honors
 *                 nested/global ignores + negations) as the include set; .git is
 *                 added explicitly so the agent can still commit / we read HEAD.
 *   dockerignore→ layered on as a tar `--exclude-from .dockerignore`.
 * With no opts, uploads the whole tree minus our scratch (the original behavior).
 */
async function hostTar(repoPath: string, respect: Set<IgnoreKind>): Promise<string> {
  const tgz = join(mkdtempSync(join(tmpdir(), "daytona-up-")), "repo.tgz");
  const isGit = existsSync(join(repoPath, ".git"));
  const dockerignore = join(repoPath, ".dockerignore");
  const useDocker = respect.has("dockerignore") && existsSync(dockerignore);

  if (respect.has("gitignore") && isGit) {
    // Build the include list from git (null-separated), then append .git.
    const ls = await capStdout("git", ["-C", repoPath, "ls-files", "-co", "--exclude-standard", "-z"]);
    if (ls.code !== 0) throw new Error("git ls-files failed while building upload set");
    const listFile = join(mkdtempSync(join(tmpdir(), "daytona-list-")), "files.null");
    writeFileSync(listFile, Buffer.concat([ls.stdout, Buffer.from(".git\0")]));
    const args = ["-czf", tgz, "-C", repoPath, "--null", "-T", listFile];
    if (useDocker) args.push("--exclude-from", dockerignore);
    await runTar(args);
    return tgz;
  }

  // Fallback: whole tree minus scratch (+ optional dockerignore).
  const args = ["--exclude=./.session", "--exclude=./node_modules", "-czf", tgz, "-C", repoPath];
  if (useDocker) args.push("--exclude-from", dockerignore);
  args.push(".");
  await runTar(args);
  return tgz;
}

class DaytonaBackend implements Backend {
  readonly kind = "daytona";
  private readonly settings: AgentSessionSettings;
  private daytona: Daytona | undefined;
  private sandbox: Sandbox | undefined;
  private disposePromise: Promise<void> | undefined;

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

  async prepare(settings: AgentSessionSettings, log: SessionLog, credentials?: Credentials): Promise<PreparedBackend> {
    if (!process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY is not set");
    this.daytona = new Daytona();
    // Bake the toolchain INTO the image (pi on a node base that already has
    // git/bash/curl), mirroring the prototype's build_image. Passing
    // onSnapshotCreateLogs makes the SDK WAIT for the image build to finish —
    // without it the sandbox comes up on a minimal default image (no bash).
    log.emit("backend", "info", `building sandbox image from ${IMAGE} (pi baked in)…`);
    const image = Image.base(IMAGE).runCommands("npm install -g @mariozechner/pi-coding-agent");
    const params = {
      image,
      // Tag so reapOrphanSandboxes() can find sandboxes WE created.
      labels: { [MANAGED_LABEL]: "true" },
      // Daytona-side self-destruct: the last line of defense against leaks if our
      // process never runs dispose(). Disabled entirely when KEEP is set.
      autoStopInterval: KEEP_SANDBOX ? 0 : AUTO_STOP_MIN,
      autoDeleteInterval: KEEP_SANDBOX ? -1 : AUTO_DELETE_MIN,
    } as CreateSandboxFromImageParams;
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
      const respect = new Set(settings.respectIgnore ?? []);
      const respectNote = respect.size > 0 ? ` (respecting ${[...respect].join(", ")})` : " (whole tree)";
      log.emit("backend", "info", `uploading local repo ${settings.target.repoPath} → ${WORKDIR} (tar+upload, no bind mount)${respectNote}`);
      const tgz = await hostTar(settings.target.repoPath, respect);
      await this.sandbox.fs.uploadFile(tgz, "/tmp/repo.tgz");
      await this.must(`tar xzf /tmp/repo.tgz -C ${WORKDIR}`, log);
    } else {
      const url = `https://github.com/${settings.target.repo}.git`;
      const token = await ghToken(credentials);
      log.emit("backend", "info", `cloning ${url} (branch ${settings.target.branch}) → ${WORKDIR}${token ? " (gh-authed)" : ""}`);
      await this.sandbox.git.clone(
        url,
        WORKDIR,
        settings.target.branch,
        undefined,
        token ? "x-access-token" : undefined,
        token || undefined,
      );
    }
    // Optionally branch off the selected base, for uploaded local repositories
    // as well as cloned GitHub targets.
    if (settings.target.newBranch) {
      log.emit("backend", "info", `creating branch ${settings.target.newBranch} off ${settings.target.branch}`);
      await this.must(`cd ${WORKDIR} && git checkout -b ${settings.target.newBranch} ${settings.target.branch}`, log);
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

    // Session exec has no stdin — upload the input to a file and redirect.
    if (opts.input !== undefined) {
      const remote = `/tmp/stdin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await this.box().fs.uploadFile(Buffer.from(opts.input, "utf8"), remote);
      command = `${command} < ${shq(remote)}`;
    }

    const cwd = opts.cwd ?? WORKDIR;
    const env = opts.env
      ? Object.entries(opts.env)
          .map(([key, value]) => shq(`${key}=${value}`))
          .join(" ")
      : "";
    const sentinel = `__AUTOMATIONS_DONE_${randomUUID().replaceAll("-", "")}__`;
    const sentinelRe = new RegExp(`${sentinel}:(-?\\d+)`);
    const sessionId = `exec-${randomUUID()}`;
    const fullCommand =
      `{ cd ${shq(cwd)} && ${env ? `env ${env} ` : ""}${command}; ` +
      `status=$?; printf '${sentinel}:%s\\n' "$status"; }`;

    log.emit("orchestrator", "debug", `exec: ${redactStr(cmd.join(" "), opts.redact)}`, { cwd, source: src, via: "daytona-session" });
    const startedAt = Date.now();
    const hb =
      opts.heartbeatMs && opts.heartbeatMs > 0
        ? setInterval(() => log.emit("backend", "info", `still running (${Math.round((Date.now() - startedAt) / 1000)}s): ${cmd[0]}`), opts.heartbeatMs)
        : undefined;
    let sessionCreated = false;
    try {
      const process = this.box().process;
      await process.createSession(sessionId);
      sessionCreated = true;
      const started = await process.executeSessionCommand(sessionId, {
        command: fullCommand,
        runAsync: true,
      });

      let stdout = "";
      let stderr = "";
      let emittedLength = 0;
      let exitCode: number | undefined;

      while (exitCode === undefined) {
        try {
          const logs = await process.getSessionCommandLogs(sessionId, started.cmdId);
          stdout = logs.stdout ?? logs.output ?? stdout;
          stderr = logs.stderr ?? stderr;

          const match = sentinelRe.exec(stdout);
          if (match?.[1] !== undefined) exitCode = Number(match[1]);

          const cleanSnapshot = stdout.replace(sentinelRe, "");
          if (opts.onStdout && cleanSnapshot.length > emittedLength) {
            opts.onStdout(cleanSnapshot.slice(emittedLength));
            emittedLength = cleanSnapshot.length;
          }
        } catch (error) {
          log.emit("backend", "warn", `session log poll failed; retrying: ${String(error)}`);
        }

        if (exitCode === undefined) {
          try {
            const status = await process.getSessionCommand(sessionId, started.cmdId);
            if (status.exitCode !== undefined && status.exitCode !== null) exitCode = status.exitCode;
          } catch (error) {
            log.emit("backend", "warn", `session status poll failed; retrying: ${String(error)}`);
          }
        }

        if (exitCode !== undefined) break;
        const elapsed = Date.now() - startedAt;
        if (opts.timeoutMs !== undefined && elapsed >= opts.timeoutMs) {
          throw new Error(`daytona command exceeded wall-clock timeout (${opts.timeoutMs}ms): ${cmd[0]}`);
        }
        const remaining =
          opts.timeoutMs === undefined ? SESSION_POLL_MS : Math.min(SESSION_POLL_MS, opts.timeoutMs - elapsed);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining)));
      }

      // The SDK exit code is only a fallback and can arrive just before the
      // final log snapshot. Fetch once more so a fast completion does not
      // truncate output when no sentinel was observed.
      if (!sentinelRe.test(stdout)) {
        try {
          const logs = await process.getSessionCommandLogs(sessionId, started.cmdId);
          stdout = logs.stdout ?? logs.output ?? stdout;
          stderr = logs.stderr ?? stderr;
          const cleanSnapshot = stdout.replace(sentinelRe, "");
          if (opts.onStdout && cleanSnapshot.length > emittedLength) {
            opts.onStdout(cleanSnapshot.slice(emittedLength));
          }
        } catch (error) {
          log.emit("backend", "warn", `final session log fetch failed: ${String(error)}`);
        }
      }

      stdout = stdout.replace(sentinelRe, "");
      if (opts.logStdout !== false && stdout.trim()) log.emit(src, "info", redactStr(stdout.trimEnd(), opts.redact));
      return { exitCode, stdout, stderr };
    } finally {
      if (hb) clearInterval(hb);
      if (sessionCreated) {
        try {
          await this.box().process.deleteSession(sessionId);
        } catch (error) {
          log.emit("backend", "warn", `failed to delete command session ${sessionId}: ${String(error)}`);
        }
      }
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

  async readBytes(path: string, _log: SessionLog): Promise<Buffer> {
    return this.box().fs.downloadFile(path);
  }

  async dispose(log: SessionLog): Promise<void> {
    // Both runSession's finally and the shutdown sweep may arrive together.
    // Share the in-flight deletion rather than returning early and letting
    // shutdown exit before the first caller finishes.
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      if (!this.sandbox || !this.daytona) return;
      if (KEEP_SANDBOX) {
        log.emit("backend", "info", `keeping sandbox ${this.sandbox.id} — daytona sandbox ssh ${this.sandbox.id}`);
        return;
      }
      await this.daytona.delete(this.sandbox);
      log.emit("backend", "info", `deleted sandbox ${this.sandbox.id}`);
    })();
    try {
      await this.disposePromise;
    } catch (err) {
      // Permit a later caller (or normal finally after a shutdown attempt) to
      // retry a transient Daytona deletion failure.
      this.disposePromise = undefined;
      throw err;
    }
  }
}

/**
 * Reap orphan sandboxes — the belt-and-suspenders cleanup for the case where a
 * process died (SIGKILL / crash) before dispose() ran and Daytona's own autoStop
 * hasn't fired yet. Deletes only sandboxes WE labelled that are NOT actively
 * running: a `started`/`starting` sandbox may belong to a concurrent instance's
 * live run, so we leave those to autoStop; `stopped`/`archived`/`error` ones are
 * idle leaks and safe to remove now. Best-effort; a delete failure is skipped.
 *
 * Returns the count reaped. No-op (returns 0) when DAYTONA_API_KEY is unset, so
 * calling it unconditionally on boot is safe for local-only deployments.
 */
export async function reapOrphanSandboxes(onLine?: (line: string) => void): Promise<number> {
  if (!process.env.DAYTONA_API_KEY || KEEP_SANDBOX) return 0;
  const daytona = new Daytona();
  let reaped = 0;
  try {
    for await (const sb of daytona.list({ labels: { [MANAGED_LABEL]: "true" } })) {
      const state = String(sb.state ?? "");
      if (state === "started" || state === "starting") continue; // maybe a live run
      try {
        await daytona.delete(sb);
        reaped += 1;
        onLine?.(`reaped orphan sandbox ${sb.id} (was ${state || "unknown"})\n`);
      } catch (err) {
        onLine?.(`could not reap sandbox ${sb.id}: ${String(err)}\n`);
      }
    }
  } catch (err) {
    onLine?.(`orphan sweep failed: ${String(err)}\n`);
  }
  return reaped;
}

registerBackend("daytona", (settings) => new DaytonaBackend(settings));
