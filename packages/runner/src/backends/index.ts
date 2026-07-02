/**
 * Backend adapter — WHERE an Agent Session runs.
 *
 * Same loop everywhere; only the location changes. A Backend gives the provider
 * a place to execute commands and a working tree. The orchestrator picks which
 * backend a session uses; the runner just resolves and drives it.
 */
import type { AgentSessionSettings, Credentials, LogSource } from "@automations/core";
import type { SessionLog } from "../logging.ts";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** true if killed by the wall-clock timeout rather than exiting on its own */
  timedOut?: boolean;
}

export interface ExecOpts {
  cwd?: string;
  /** piped to the process's stdin (how we feed pi its prompt) */
  input?: string;
  /** merged over the ambient environment */
  env?: Record<string, string>;
  /** wall-clock kill switch + heartbeat cadence (§2.7) */
  timeoutMs?: number;
  heartbeatMs?: number;
  /**
   * Which log source this command's output belongs to (§3.2). The exec layer
   * can't know a command's *meaning*, so the caller declares it:
   *   "agent"        — the agent program itself (pi)
   *   "workload"     — a program the agent/orchestrator runs (dev server, browser, tests)
   *   "orchestrator" — runner/orchestrator bookkeeping (git rev-parse, status, …)
   * Defaults to "orchestrator": a bare exec with no stated meaning is bookkeeping.
   */
  source?: LogSource;
  /** observe stdout as it streams (line-by-line parsing of live event output) */
  onStdout?: (chunk: string) => void;
  /** emit raw stdout chunks to the log (default true). Set false when the caller
   *  parses the stream itself via onStdout and would otherwise double-log noise. */
  logStdout?: boolean;
  /** secrets to mask (→ "***") in the logged command + output, e.g. a push token */
  redact?: string[];
}

/** Mask any redact strings in a log line so secrets never hit the logs. */
export function redactStr(s: string, redact?: string[]): string {
  if (!redact) return s;
  let out = s;
  for (const secret of redact) if (secret) out = out.split(secret).join("***");
  return out;
}

/** A file read back FROM the backend's filesystem (which may be a container). */
export interface BackendFile {
  /** path as seen inside the backend */
  path: string;
  content: string;
  mtimeMs: number;
}

export interface PreparedBackend {
  /** where the repo/working tree lives inside the backend */
  workdir: string;
  /**
   * A fresh, writable directory inside the backend, OUTSIDE the repo, for the
   * agent's own session files (e.g. pi's transcript). Fresh per session, so the
   * provider never has to disambiguate a stale transcript.
   */
  scratchDir: string;
}

export interface Backend {
  readonly kind: string;
  /**
   * Stand up the execution environment + working tree + scratch dir. `credentials`
   * carries per-principal secrets a backend may need to fetch the tree (e.g. the
   * GitHub token daytona uses to clone a private repo). Backends that don't need
   * secrets (local/container bind-mount) may ignore it.
   */
  prepare(settings: AgentSessionSettings, log: SessionLog, credentials?: Credentials): Promise<PreparedBackend>;
  /**
   * The backend's current wall-clock as epoch milliseconds. The orchestrator
   * samples this once up front to compute the offset between the backend's clock
   * and the host clock (the canonical "real" timeline), so timestamps recorded
   * *inside* the backend (e.g. pi's transcript) can be normalized to host time.
   * Local/bare-metal shares the host clock, so this is just Date.now().
   */
  now(log: SessionLog): Promise<number>;
  /** run a command in the environment, streaming output to the backend log */
  exec(cmd: string[], opts: ExecOpts, log: SessionLog): Promise<ExecResult>;
  /**
   * Read every file under `dir` whose name ends with `ext`, FROM the backend's
   * filesystem. Lets the runner fetch pi's transcript regardless of where the
   * session ran (host fs for local; `docker exec` for a container).
   */
  readDir(dir: string, ext: string, log: SessionLog): Promise<BackendFile[]>;
  /** Read a single file's raw bytes from the backend (binary-safe, unlike
   *  readDir which is text). Used to pull published artifacts — e.g. a QA
   *  screenshot — out of the backend before it is disposed. */
  readBytes(path: string, log: SessionLog): Promise<Buffer>;
  /** tear down (or keep, for debugging) */
  dispose(log: SessionLog): Promise<void>;
}

export type BackendFactory = (settings: AgentSessionSettings) => Backend;

const registry = new Map<string, BackendFactory>();

export function registerBackend(kind: string, factory: BackendFactory): void {
  registry.set(kind, factory);
}

export function resolveBackend(settings: AgentSessionSettings): Backend {
  const factory = registry.get(settings.backend);
  if (!factory) {
    throw new Error(
      `no backend registered for "${settings.backend}" (have: ${[...registry.keys()].join(", ") || "none"})`,
    );
  }
  return factory(settings);
}
